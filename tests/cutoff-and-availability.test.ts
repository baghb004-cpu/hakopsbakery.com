/**
 * The order cutoff, including the two days a year the clocks move.
 *
 * The cutoff is a wall clock time in Cypress: eight in the evening, two days
 * before the bake. Daylight saving means eight in the evening is a different
 * instant in March than it is in January, and code that treats the offset as
 * a constant is wrong for part of the year. It closes ordering an hour early
 * on one side of the change and an hour late on the other, and the hour it
 * is wrong by is the last hour before a deadline, which is when people
 * actually order.
 *
 * In 2026 the clocks go forward on 8 March and back on 1 November.
 */

import { describe, expect, it } from "vitest";
import { buildBakeSchedule, cutoffInstantFor, isPastCutoff } from "@lib/bake-schedule";
import { handleCheckAvailability } from "../netlify/functions/check-availability";
import { handleCreateCheckoutSession } from "../netlify/functions/create-checkout-session";
import { DISCLOSURE_VERSION } from "../netlify/functions/_shared/env";
import {
  harness,
  postJson,
  readBody,
  testCatalog,
  testCompliance,
  testFulfillment,
  testSchedule,
  testSettings,
} from "./function-harness";

const CUTOFF = { hour: 20, minute: 0, daysBefore: 2 };
const LA = "America/Los_Angeles";

/* ------------------------------------------------------------------ */
/* The rule itself                                                     */
/* ------------------------------------------------------------------ */

describe("the cutoff instant", () => {
  it("uses standard time before the spring change", () => {
    /* Monday 9 March. Ordering closed Saturday 7 March at 8pm, still PST. */
    expect(cutoffInstantFor("2026-03-09", CUTOFF, LA).toISOString()).toBe(
      "2026-03-08T04:00:00.000Z",
    );
  });

  it("uses daylight time after it", () => {
    /* Wednesday 11 March. Closed Monday 9 March at 8pm, now PDT. */
    expect(cutoffInstantFor("2026-03-11", CUTOFF, LA).toISOString()).toBe(
      "2026-03-10T03:00:00.000Z",
    );
  });

  it("uses daylight time before the autumn change", () => {
    expect(cutoffInstantFor("2026-10-31", CUTOFF, LA).toISOString()).toBe(
      "2026-10-30T03:00:00.000Z",
    );
  });

  it("uses standard time after it", () => {
    expect(cutoffInstantFor("2026-11-04", CUTOFF, LA).toISOString()).toBe(
      "2026-11-03T04:00:00.000Z",
    );
  });

  it("is the same wall clock time on both sides, and a different instant", () => {
    /*
      The point of the four cases above, in one assertion. Two bake dates two
      days apart, both closing at eight in the evening in Cypress, an hour
      apart in UTC. A fixed offset cannot produce both.
      */
    const before = cutoffInstantFor("2026-03-09", CUTOFF, LA).getTime();
    const after = cutoffInstantFor("2026-03-11", CUTOFF, LA).getTime();
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    expect(after - before).toBe(twoDays - 60 * 60 * 1000);
  });

  it("closes at the stroke of the hour, not a moment after", () => {
    const closes = cutoffInstantFor("2026-03-11", CUTOFF, LA);
    expect(isPastCutoff("2026-03-11", CUTOFF, LA, new Date(closes.getTime() - 1))).toBe(false);
    expect(isPastCutoff("2026-03-11", CUTOFF, LA, closes)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Through the checkout function                                       */
/* ------------------------------------------------------------------ */

function checkoutAt(now: Date, bakeDate: string) {
  const bench = harness();
  return {
    bench,
    run: () =>
      handleCreateCheckoutSession(
        postJson("/api/create-checkout-session", {
          lines: [{ sku: "HB-TEST-01", variantId: "full-tray", qty: 1 }],
          fulfillment: { mode: "pickup", zip: null, bakeDate, slotId: null },
          consent: { accepted: true, version: DISCLOSURE_VERSION },
        }),
        {
          now: () => now,
          catalog: async () => testCatalog(),
          store: bench.store,
          stripe: bench.stripe,
          fulfillment: testFulfillment(),
          schedule: testSchedule(),
          settings: testSettings(),
          compliance: testCompliance(),
          storeOpen: true,
          rateLimiter: bench.rateLimiter,
          logger: bench.logger,
          successPath: "/order/confirmed/",
          cancelPath: "/cart/",
        },
      ),
  };
}

describe("checkout at the boundary, across the spring change", () => {
  it("takes an order one millisecond before the cutoff", async () => {
    const response = await checkoutAt(
      new Date("2026-03-10T02:59:59.999Z"),
      "2026-03-11",
    ).run();
    expect(response.status).toBe(200);
  });

  it("refuses the same order at the cutoff itself", async () => {
    const response = await checkoutAt(new Date("2026-03-10T03:00:00.000Z"), "2026-03-11").run();
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-past-cutoff" });
  });

  it("would have been an hour wrong with a fixed offset", async () => {
    /*
      A fixed minus eight would put this cutoff at 04:00Z and would still be
      taking orders at 03:30Z, an hour after Hakop drew up the list.
    */
    const response = await checkoutAt(new Date("2026-03-10T03:30:00.000Z"), "2026-03-11").run();
    expect(response.status).toBe(409);
  });
});

describe("checkout at the boundary, across the autumn change", () => {
  it("takes an order one millisecond before the cutoff", async () => {
    const response = await checkoutAt(
      new Date("2026-11-03T03:59:59.999Z"),
      "2026-11-04",
    ).run();
    expect(response.status).toBe(200);
  });

  it("refuses the same order at the cutoff itself", async () => {
    const response = await checkoutAt(new Date("2026-11-03T04:00:00.000Z"), "2026-11-04").run();
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-past-cutoff" });
  });

  it("would have been an hour wrong the other way with a fixed offset", async () => {
    /*
      A fixed minus seven would put this cutoff at 03:00Z and would have
      refused an order placed at 03:30Z, which was in good time.
    */
    const response = await checkoutAt(new Date("2026-11-03T03:30:00.000Z"), "2026-11-04").run();
    expect(response.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* check-availability                                                  */
/* ------------------------------------------------------------------ */

function availabilityDeps(now: Date, overrides: Record<string, unknown> = {}) {
  const bench = harness();
  return {
    bench,
    deps: {
      schedule: testSchedule(),
      store: bench.store,
      rateLimiter: bench.rateLimiter,
      now: () => now,
      ...overrides,
    },
  };
}

function get(path: string): Request {
  return new Request(`https://hakopsbakery.com${path}`);
}

describe("check-availability", () => {
  it("never lets an answer be cached", async () => {
    const { deps } = availabilityDeps(new Date("2026-09-11T17:00:00.000Z"));
    const response = await handleCheckAvailability(get("/api/check-availability"), deps);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("offers no Tuesdays", async () => {
    const { deps } = availabilityDeps(new Date("2026-09-11T17:00:00.000Z"));
    const body = await readBody(
      await handleCheckAvailability(get("/api/check-availability"), deps),
    );
    const dates = body["dates"] as Array<{ date: string; weekday: number }>;
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.some((entry) => entry.weekday === 2)).toBe(false);
  });

  it("shows a sold out date as sold out rather than hiding it", async () => {
    const { bench, deps } = availabilityDeps(new Date("2026-09-11T17:00:00.000Z"));
    await bench.store.reserve({
      holdId: "hold_full",
      bakeDate: "2026-09-13",
      pieces: 48,
      capacityPieces: 48,
      orderRef: "HB-FULL",
      expiresAt: new Date("2026-09-11T17:00:00.000Z").getTime() + 600_000,
      now: new Date("2026-09-11T17:00:00.000Z").getTime(),
    });

    const body = await readBody(
      await handleCheckAvailability(get("/api/check-availability?date=2026-09-13"), deps),
    );
    const requested = body["requested"] as Record<string, unknown>;
    expect(requested["status"]).toBe("sold-out");
    expect(requested["selectable"]).toBe(false);
    expect(requested["remainingPieces"]).toBe(0);
  });

  it("releases the capacity again when a hold expires", async () => {
    const now = new Date("2026-09-11T17:00:00.000Z");
    const { bench, deps } = availabilityDeps(now);
    await bench.store.reserve({
      holdId: "hold_abandoned",
      bakeDate: "2026-09-13",
      pieces: 48,
      capacityPieces: 48,
      orderRef: "HB-ABANDONED",
      /* Somebody opened checkout and walked away. */
      expiresAt: now.getTime() - 1,
      now: now.getTime() - 2,
    });

    const body = await readBody(
      await handleCheckAvailability(get("/api/check-availability?date=2026-09-13"), deps),
    );
    expect((body["requested"] as Record<string, unknown>)["selectable"]).toBe(true);
  });

  it("reports the cutoff for each date in UTC, correct across the change", async () => {
    const { deps } = availabilityDeps(new Date("2026-03-07T18:00:00.000Z"), {
      schedule: testSchedule({ horizonDays: 7 }),
    });
    const body = await readBody(
      await handleCheckAvailability(get("/api/check-availability"), deps),
    );
    const dates = body["dates"] as Array<{ date: string; cutoffAt: string }>;
    expect(dates.find((entry) => entry.date === "2026-03-09")?.cutoffAt).toBe(
      "2026-03-08T04:00:00.000Z",
    );
    expect(dates.find((entry) => entry.date === "2026-03-11")?.cutoffAt).toBe(
      "2026-03-10T03:00:00.000Z",
    );
  });

  it("offers nothing at all when the batch size has never been set", async () => {
    const { deps } = availabilityDeps(new Date("2026-09-11T17:00:00.000Z"), { schedule: null });
    const response = await handleCheckAvailability(get("/api/check-availability"), deps);
    expect(response.status).toBe(503);
    expect((await readBody(response))["error"]).toMatchObject({
      code: "availability-not-configured",
    });
  });

  it("counts a confirmed order against the date it was bought for", async () => {
    const now = new Date("2026-09-11T17:00:00.000Z");
    const { bench, deps } = availabilityDeps(now);
    await bench.store.reserve({
      holdId: "hold_paid",
      bakeDate: "2026-09-13",
      pieces: 24,
      capacityPieces: 48,
      orderRef: "HB-PAID",
      expiresAt: now.getTime() - 1,
      now: now.getTime() - 2,
    });
    await bench.store.confirmHold("hold_paid", "HB-PAID", now.getTime());

    const body = await readBody(
      await handleCheckAvailability(get("/api/check-availability?date=2026-09-13"), deps),
    );
    /* A paid order holds its capacity for good, expiry or not. */
    expect((body["requested"] as Record<string, unknown>)["remainingPieces"]).toBe(24);
  });
});

describe("the schedule the picker and the checkout both read", () => {
  it("is the same answer in both, because it is the same function", () => {
    const now = new Date("2026-09-11T17:00:00.000Z");
    const schedule = buildBakeSchedule({ config: testSchedule(), now });
    const sunday = schedule.dates.find((entry) => entry.date === "2026-09-13");
    expect(sunday?.selectable).toBe(true);
    expect(sunday?.capacity.capacityPieces).toBe(48);
    expect(schedule.today).toBe("2026-09-11");
  });
});
