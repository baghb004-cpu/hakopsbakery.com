/**
 * Two things that let a bake day be oversold, and one that made the annual
 * ceiling read low for the last eight hours of every year.
 *
 * Every test in here failed before the fix it guards. They are written
 * against behaviour, not implementation: what a customer can take, and which
 * year a sale is filed under.
 */

import { describe, expect, it } from "vitest";
import { calendarYearIn } from "@lib/bake-schedule";
import { createMemoryOrderStore } from "../netlify/functions/_shared/store";
import { capMeter } from "../netlify/functions/_shared/cap";
import { handleStripeWebhook } from "../netlify/functions/stripe-webhook";
import { signWebhookPayload } from "../netlify/functions/_shared/stripe-gateway";
import {
  harness,
  postRaw,
  testCompliance,
  testFulfillment,
  testSettings,
} from "./function-harness";

const SHOP_TZ = "America/Los_Angeles";

/** A Saturday with room for one hundred pieces. */
const BAKE_DATE = "2026-09-19";

function orderRecord(overrides: {
  sessionId: string;
  createdAt: string;
  capContributionCents: number;
}) {
  return {
    orderRef: `HB-${overrides.sessionId}`,
    sessionId: overrides.sessionId,
    paymentIntentId: null,
    status: "paid" as const,
    bakeDate: BAKE_DATE,
    mode: "pickup",
    zip: null,
    lines: [],
    piecesTotal: 24,
    amountTotalCents: overrides.capContributionCents,
    amountTaxCents: 0,
    capContributionCents: overrides.capContributionCents,
    customerEmail: null,
    createdAt: overrides.createdAt,
  };
}

/* ------------------------------------------------------------------ */

describe("capacity a lapsed hold has already given back", () => {
  /*
    The hold id is derived from the contents of the cart, so a customer who
    abandons a checkout and comes back later with the same cart asks for the
    same hold id. By then their first hold has expired and its pieces have
    gone back to the date, and somebody else may have bought them.
  */
  it("does not let a returning customer take pieces somebody else has bought", async () => {
    const store = createMemoryOrderStore();
    const opened = 1_000_000;
    const capacityPieces = 100;

    const first = await store.reserve({
      holdId: "hold_returning",
      bakeDate: BAKE_DATE,
      pieces: 40,
      capacityPieces,
      orderRef: "HB-RETURNING",
      expiresAt: opened + 1_800_000,
      now: opened,
    });
    expect(first.ok).toBe(true);

    /* Half an hour later that hold has lapsed. */
    const later = opened + 1_800_001;

    /* Somebody else buys eighty of the hundred pieces and pays for them. */
    const other = await store.reserve({
      holdId: "hold_other",
      bakeDate: BAKE_DATE,
      pieces: 80,
      capacityPieces,
      orderRef: "HB-OTHER",
      expiresAt: later + 1_800_000,
      now: later,
    });
    expect(other.ok).toBe(true);
    await store.confirmHold("hold_other", "HB-OTHER", later);

    /* Twenty pieces are left. The first customer comes back wanting forty. */
    const returning = await store.reserve({
      holdId: "hold_returning",
      bakeDate: BAKE_DATE,
      pieces: 40,
      capacityPieces,
      orderRef: "HB-RETURNING",
      expiresAt: later + 1_800_000,
      now: later,
    });

    expect(returning.ok).toBe(false);
    if (!returning.ok) expect(returning.remainingPieces).toBe(20);

    const live = (await store.committedOrders(later)).reduce(
      (total, order) => total + (order.lines[0]?.qty ?? 0),
      0,
    );
    expect(live).toBeLessThanOrEqual(capacityPieces);
  });

  it("still hands a live hold back to a retry without claiming twice", async () => {
    const store = createMemoryOrderStore();
    const now = 1_000_000;
    const input = {
      holdId: "hold_retry",
      bakeDate: BAKE_DATE,
      pieces: 40,
      capacityPieces: 100,
      orderRef: "HB-RETRY",
      expiresAt: now + 1_800_000,
      now,
    };

    expect((await store.reserve(input)).ok).toBe(true);
    const again = await store.reserve({ ...input, now: now + 1000 });

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reused).toBe(true);
    expect(store.state.holds.size).toBe(1);

    const live = (await store.committedOrders(now + 1000)).reduce(
      (total, order) => total + (order.lines[0]?.qty ?? 0),
      0,
    );
    expect(live).toBe(40);
  });
});

describe("confirming a hold that had already lapsed", () => {
  /*
    A bank debit completes the Checkout Session before the money moves, and
    `async_payment_succeeded` can arrive days later, long after the thirty
    minute hold expired and the date was resold. The order is real and its
    pieces count, but the date may now be oversold and nobody would know.
  */
  it("reports that there was no live hold, so the date gets looked at", async () => {
    const store = createMemoryOrderStore();
    const opened = 1_000_000;

    await store.reserve({
      holdId: "hold_slow_payment",
      bakeDate: BAKE_DATE,
      pieces: 40,
      capacityPieces: 100,
      orderRef: "HB-SLOW",
      expiresAt: opened + 1_800_000,
      now: opened,
    });

    const muchLater = opened + 3 * 86_400_000;
    const wasLive = await store.confirmHold("hold_slow_payment", "HB-SLOW", muchLater);

    expect(wasLive).toBe(false);
    /* Confirmed all the same: the order is paid and the pieces are real. */
    expect(store.state.holds.get("hold_slow_payment")?.confirmed).toBe(true);
    const live = (await store.committedOrders(muchLater)).reduce(
      (total, order) => total + (order.lines[0]?.qty ?? 0),
      0,
    );
    expect(live).toBe(40);
  });

  it("says a hold that is still live was live", async () => {
    const store = createMemoryOrderStore();
    const now = 1_000_000;
    await store.reserve({
      holdId: "hold_prompt",
      bakeDate: BAKE_DATE,
      pieces: 40,
      capacityPieces: 100,
      orderRef: "HB-PROMPT",
      expiresAt: now + 1_800_000,
      now,
    });
    expect(await store.confirmHold("hold_prompt", "HB-PROMPT", now + 60_000)).toBe(true);
  });
});

describe("which year a sale counts against", () => {
  /*
    2026-12-31 18:00 in Cypress is 2027-01-01T02:00Z. The ceiling is a
    calendar year ceiling and the calendar is the one on the wall in Cypress.
  */
  const NEW_YEARS_EVE_EVENING = new Date("2027-01-01T02:00:00.000Z");

  it("files an evening sale on the thirty first under the shop's year", async () => {
    const store = createMemoryOrderStore();
    await store.recordOrder(
      orderRecord({
        sessionId: "cs_nye",
        createdAt: NEW_YEARS_EVE_EVENING.toISOString(),
        capContributionCents: 6400,
      }),
    );

    expect(calendarYearIn(NEW_YEARS_EVE_EVENING, SHOP_TZ)).toBe(2026);
    expect(await store.capTotalCents(2026, SHOP_TZ)).toBe(6400);
    expect(await store.capTotalCents(2027, SHOP_TZ)).toBe(0);
  });

  it("starts the new year empty at midnight in Cypress, not at four in the afternoon", async () => {
    const store = createMemoryOrderStore();
    /* 2027-01-01 00:30 Pacific. */
    const justAfterMidnight = new Date("2027-01-01T08:30:00.000Z");
    await store.recordOrder(
      orderRecord({
        sessionId: "cs_new_year",
        createdAt: justAfterMidnight.toISOString(),
        capContributionCents: 5200,
      }),
    );

    expect(await store.capTotalCents(2026, SHOP_TZ)).toBe(0);
    expect(await store.capTotalCents(2027, SHOP_TZ)).toBe(5200);
  });

  it("warns Hakop about the year he is actually still selling in", async () => {
    /*
      The year is nearly spent. One more order lands at six in the evening on
      the thirty first. Read off a UTC clock the meter looks at an empty new
      year and says nothing, which is the whole failure: the ceiling stops
      being measured while sales are still being made against it.
    */
    const bench = harness();
    const settings = testSettings({ annualCapCents: 1_000_000 });

    await bench.store.recordOrder(
      orderRecord({
        sessionId: "cs_earlier_in_2026",
        createdAt: "2026-06-01T12:00:00.000Z",
        capContributionCents: 980_000,
      }),
    );

    const secret = "whsec_test_cap_year";
    const payload = {
      id: "evt_cap_year_0001",
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(NEW_YEARS_EVE_EVENING.getTime() / 1000),
      data: {
        object: {
          id: "cs_nye_webhook",
          amount_subtotal: 5200,
          amount_total: 5200,
          total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
          payment_status: "paid",
          payment_intent: "pi_nye",
          customer_details: { email: null, address: null },
          metadata: {
            orderRef: "HB-NYE000001",
            bakeDate: "2027-01-03",
            fulfillmentMode: "pickup",
            piecesTotal: "24",
            lines: "HB-TEST-01:full-tray:1",
          },
        },
      },
    };

    const body = JSON.stringify(payload);
    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", body, {
        "stripe-signature": signWebhookPayload(body, secret),
      }),
      {
        now: () => NEW_YEARS_EVE_EVENING,
        store: bench.store,
        stripe: bench.stripe,
        emailer: bench.emailer,
        fulfillment: testFulfillment(),
        settings,
        compliance: testCompliance(),
        webhookSecret: secret,
        logger: bench.logger,
      },
    );

    expect(response.status).toBe(200);

    const used = await bench.store.capTotalCents(2026, SHOP_TZ);
    expect(used).toBe(985_200);
    expect(capMeter(used, settings.annualCapCents).level).toBe("loud");

    const codes = bench.store.state.flags.map((flag) => flag.code);
    expect(codes).toContain("annual-cap-loud");
  });
});
