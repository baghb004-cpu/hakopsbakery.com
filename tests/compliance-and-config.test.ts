/**
 * The server side copy of the compliance wording, the launch gates, and the
 * capacity store.
 *
 * The first block is the guard that makes a duplicated constant safe. A
 * Netlify function cannot import `src/config/site.ts`, because that module
 * reads `import.meta.env`, which Vite fills in at build time and which is
 * undefined in a bundled function. So two constants are written out twice,
 * and this test fails the moment the two copies differ by a single
 * character. A consent record that quotes different wording from the page
 * the customer read is not evidence of anything.
 */

import { describe, expect, it } from "vitest";
import { compliance } from "@config/site";
import {
  DISCLOSURE_VERSION,
  HOME_KITCHEN_STATEMENT,
  bakeScheduleConfigFromEnv,
  complianceConfig,
  envList,
  fulfillmentConfigFromEnv,
  shopSettings,
  storeIsOpen,
} from "../netlify/functions/_shared/env";
import { createMemoryOrderStore } from "../netlify/functions/_shared/store";
import { capMeter } from "../netlify/functions/_shared/cap";

describe("the wording does not drift", () => {
  it("matches src/config/site.ts word for word", () => {
    expect(HOME_KITCHEN_STATEMENT).toBe(compliance.homeKitchenStatement);
    expect(DISCLOSURE_VERSION).toBe(compliance.disclosureVersion);
  });

  it("is the wording the county requires, not a paraphrase", () => {
    expect(HOME_KITCHEN_STATEMENT).toBe(
      "Made in a home kitchen that is not inspected by the Department of Public Health.",
    );
  });
});

describe("the launch gate, server side", () => {
  it("stays shut when the flag is on but there is no registration number", () => {
    expect(storeIsOpen({ PUBLIC_STORE_OPEN: "true" })).toBe(false);
    expect(storeIsOpen({ PUBLIC_STORE_OPEN: "true", PUBLIC_CFO_REGISTRATION_NUMBER: "" })).toBe(
      false,
    );
    expect(storeIsOpen({ PUBLIC_STORE_OPEN: "true", PUBLIC_CFO_REGISTRATION_NUMBER: "   " })).toBe(
      false,
    );
  });

  it("stays shut when there is a registration number but the flag is off", () => {
    expect(storeIsOpen({ PUBLIC_CFO_REGISTRATION_NUMBER: "CFO-1234" })).toBe(false);
    expect(
      storeIsOpen({ PUBLIC_STORE_OPEN: "false", PUBLIC_CFO_REGISTRATION_NUMBER: "CFO-1234" }),
    ).toBe(false);
  });

  it("opens only when both are true", () => {
    expect(
      storeIsOpen({ PUBLIC_STORE_OPEN: "true", PUBLIC_CFO_REGISTRATION_NUMBER: "CFO-1234" }),
    ).toBe(true);
  });

  it("reports the county and the number it will publish", () => {
    const config = complianceConfig({
      PUBLIC_CFO_REGISTRATION_NUMBER: "CFO-1234",
      PUBLIC_CFO_COUNTY: "Orange County",
    });
    expect(config.complete).toBe(true);
    expect(config.registrationNumber).toBe("CFO-1234");
    expect(config.statement).toBe(compliance.homeKitchenStatement);
  });
});

describe("configuration read from the environment", () => {
  it("offers no bake dates until somebody says how big a batch is", () => {
    expect(bakeScheduleConfigFromEnv({})).toBeNull();
    expect(bakeScheduleConfigFromEnv({ BAKE_PIECES_PER_BATCH: "0" })).toBeNull();
    expect(bakeScheduleConfigFromEnv({ BAKE_PIECES_PER_BATCH: "not a number" })).toBeNull();
  });

  it("reads the weekly pattern and the cutoff", () => {
    const schedule = bakeScheduleConfigFromEnv({
      BAKE_PIECES_PER_BATCH: "24",
      BAKE_BATCHES_BY_WEEKDAY: "0:2, 3:2, 6:4",
      ORDER_CUTOFF_HOUR: "18",
      ORDER_CUTOFF_DAYS_BEFORE: "3",
      BAKE_BLACKOUT_DATES: "2026-12-24,2026-12-25,not-a-date",
    });
    expect(schedule).not.toBeNull();
    expect(schedule?.piecesPerBatch).toBe(24);
    expect(schedule?.availability.batchesByWeekday).toEqual({ 0: 2, 3: 2, 6: 4 });
    expect(schedule?.cutoff).toMatchObject({ hour: 18, daysBefore: 3 });
    expect(schedule?.blackoutDates).toEqual(["2026-12-24", "2026-12-25"]);
  });

  it("survives a malformed override list rather than taking availability down", () => {
    const schedule = bakeScheduleConfigFromEnv({
      BAKE_PIECES_PER_BATCH: "24",
      BAKE_DATE_OVERRIDES: "{ this is not json",
    });
    expect(schedule?.dateOverrides).toEqual({});
  });

  it("uses the shop's own delivery list when one is configured", () => {
    const config = fulfillmentConfigFromEnv({
      DELIVERY_ZIPS: "90630 90620,90623",
      DELIVERY_FEE_CENTS: "700",
      SHIPPING_AVAILABLE: "false",
    });
    expect(config.delivery.zips).toEqual(["90630", "90620", "90623"]);
    expect(config.delivery.feeCents).toBe(700);
    expect(config.shipping.available).toBe(false);
  });

  it("treats an empty variable exactly like a missing one", () => {
    expect(envList("NOTHING_HERE", { NOTHING_HERE: "   " })).toBeNull();
    expect(shopSettings({ PUBLIC_SITE_URL: "" }).siteUrl).toBe("https://hakopsbakery.com");
  });

  it("trims a trailing slash off the site URL, so links do not double up", () => {
    expect(shopSettings({ PUBLIC_SITE_URL: "https://example.com/" }).siteUrl).toBe(
      "https://example.com",
    );
  });

  it("keeps a session alive at least as long as Stripe allows", () => {
    expect(shopSettings({ CHECKOUT_SESSION_TTL_MINUTES: "5" }).sessionTtlMinutes).toBe(30);
  });
});

describe("the capacity store", () => {
  const now = Date.parse("2026-09-11T17:00:00.000Z");

  function reserve(store: ReturnType<typeof createMemoryOrderStore>, holdId: string, pieces: number) {
    return store.reserve({
      holdId,
      bakeDate: "2026-09-13",
      pieces,
      capacityPieces: 48,
      orderRef: holdId,
      expiresAt: now + 1_800_000,
      now,
    });
  }

  it("lets the last batch go to exactly one person", async () => {
    const store = createMemoryOrderStore();
    const first = await reserve(store, "hold_a", 48);
    const second = await reserve(store, "hold_b", 1);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.remainingPieces).toBe(0);
  });

  it("hands the same hold back to a retry rather than claiming twice", async () => {
    const store = createMemoryOrderStore();
    const first = await reserve(store, "hold_same", 24);
    const again = await reserve(store, "hold_same", 24);

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reused).toBe(true);
    expect(store.state.holds.size).toBe(1);
  });

  it("frees an abandoned hold and keeps a paid one", async () => {
    const store = createMemoryOrderStore();
    await store.reserve({
      holdId: "hold_abandoned",
      bakeDate: "2026-09-13",
      pieces: 24,
      capacityPieces: 48,
      orderRef: "HB-ABANDONED",
      expiresAt: now - 1,
      now: now - 2,
    });
    await store.reserve({
      holdId: "hold_paid",
      bakeDate: "2026-09-13",
      pieces: 24,
      capacityPieces: 48,
      orderRef: "HB-PAID",
      expiresAt: now - 1,
      now: now - 2,
    });
    await store.confirmHold("hold_paid", "HB-PAID");

    const committed = await store.committedOrders(now);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.bakeDate).toBe("2026-09-13");
  });

  it("never releases a hold that belongs to a paid order", async () => {
    const store = createMemoryOrderStore();
    await reserve(store, "hold_paid", 24);
    await store.confirmHold("hold_paid", "HB-PAID");
    await store.releaseHold("hold_paid");
    expect(store.state.holds.has("hold_paid")).toBe(true);
  });

  it("claims an event id once and gives it back on failure", async () => {
    const store = createMemoryOrderStore();
    expect(await store.beginEvent("evt_1", now)).toBe("fresh");
    expect(await store.beginEvent("evt_1", now)).toBe("in-flight");

    await store.completeEvent("evt_1");
    expect(await store.beginEvent("evt_1", now)).toBe("done");

    await store.failEvent("evt_1");
    expect(await store.beginEvent("evt_1", now)).toBe("fresh");
  });

  it("counts only paid orders toward the annual ceiling", async () => {
    const store = createMemoryOrderStore();
    const base = {
      orderRef: "HB-1",
      paymentIntentId: null,
      bakeDate: "2026-09-13",
      mode: "pickup",
      zip: null,
      lines: [],
      piecesTotal: 24,
      amountTotalCents: 6855,
      amountTaxCents: 455,
      customerEmail: null,
      createdAt: "2026-09-11T17:00:00.000Z",
    };
    await store.recordOrder({ ...base, sessionId: "cs_1", status: "paid", capContributionCents: 6400 });
    await store.recordOrder({
      ...base,
      orderRef: "HB-2",
      sessionId: "cs_2",
      status: "refunded-out-of-state",
      capContributionCents: 0,
    });

    expect(await store.capTotalCents(2026)).toBe(6400);
    expect(capMeter(await store.capTotalCents(2026), 8_600_000).level).toBe("ok");
  });
});
