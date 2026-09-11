/**
 * check-delivery-zone. The first of the three places the California gate is
 * enforced, and the only one a determined person can walk around, which is
 * why the other two exist.
 */

import { describe, expect, it } from "vitest";
import { handleCheckDeliveryZone } from "../netlify/functions/check-delivery-zone";
import type { ZoneDeps } from "../netlify/functions/check-delivery-zone";
import { createRateLimiter } from "../netlify/functions/_shared/rate-limit";
import { fulfillmentConfigFromEnv } from "../netlify/functions/_shared/env";
import { postJson, readBody, testFulfillment } from "./function-harness";

interface ModeAnswer {
  readonly mode: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly message: string | null;
  readonly feeCents: number | null;
  readonly shortfallCents: number | null;
}

function deps(overrides: Partial<ZoneDeps> = {}): ZoneDeps {
  return {
    fulfillment: testFulfillment(),
    rateLimiter: createRateLimiter(),
    now: () => new Date("2026-09-11T17:00:00.000Z"),
    ...overrides,
  };
}

async function ask(body: unknown, custom: Partial<ZoneDeps> = {}) {
  const response = await handleCheckDeliveryZone(
    postJson("/api/check-delivery-zone", body),
    deps(custom),
  );
  const parsed = await readBody(response);
  return {
    response,
    body: parsed,
    modes: (parsed["modes"] ?? []) as ModeAnswer[],
    mode: (name: string): ModeAnswer => {
      const found = ((parsed["modes"] ?? []) as ModeAnswer[]).find((entry) => entry.mode === name);
      if (found === undefined) throw new Error(`no answer for ${name}`);
      return found;
    },
  };
}

describe("a ZIP outside California", () => {
  it("is refused, and told why, for shipping", async () => {
    /* 89101 is Las Vegas. */
    const answer = await ask({ zip: "89101" });

    expect(answer.response.status).toBe(200);
    expect(answer.body["inCalifornia"]).toBe(false);
    expect(answer.body["reason"]).toBe("out-of-state");
    expect(answer.body["zip"]).toBeNull();

    expect(answer.mode("shipping").available).toBe(false);
    expect(answer.mode("shipping").reason).toBe("out-of-state");
    expect(String(answer.mode("shipping").message)).toContain("California");
    expect(answer.mode("delivery").available).toBe(false);
  });

  it("is refused for every state neighbouring the range", async () => {
    /* Just below the California block, and just above it. */
    for (const zip of ["89899", "96163", "97201", "99501", "00501", "10001"]) {
      const answer = await ask({ zip });
      expect(answer.body["inCalifornia"]).toBe(false);
      expect(answer.mode("shipping").available).toBe(false);
    }
  });

  it("still offers pickup, because pickup happens at the door", async () => {
    const answer = await ask({ zip: "89101" });
    expect(answer.mode("pickup").available).toBe(true);
  });
});

describe("a ZIP inside California", () => {
  it("opens shipping anywhere in the state", async () => {
    /* 95814 is Sacramento: in California, nowhere near the delivery run. */
    const answer = await ask({ zip: "95814" });
    expect(answer.body["inCalifornia"]).toBe(true);
    expect(answer.body["zip"]).toBe("95814");
    expect(answer.mode("shipping").available).toBe(true);
    expect(answer.mode("shipping").feeCents).toBe(1200);
    expect(answer.mode("delivery").available).toBe(false);
    expect(answer.mode("delivery").reason).toBe("outside-delivery-area");
  });

  it("opens delivery inside the run", async () => {
    const answer = await ask({ zip: "90630" });
    expect(answer.mode("delivery").available).toBe(true);
    expect(answer.mode("delivery").feeCents).toBe(500);
  });

  it("accepts a ZIP plus four, because browsers autofill one", async () => {
    const answer = await ask({ zip: "90630-1234" });
    expect(answer.body["zip"]).toBe("90630");
    expect(answer.mode("delivery").available).toBe(true);
  });

  it("reports the shortfall when a cart is under the delivery minimum", async () => {
    const answer = await ask({ zip: "90630", subtotalCents: 1500 });
    expect(answer.mode("delivery").available).toBe(false);
    expect(answer.mode("delivery").reason).toBe("below-minimum");
    expect(answer.mode("delivery").shortfallCents).toBe(500);
  });
});

describe("bad input", () => {
  it("tells somebody who typed three digits what is wrong", async () => {
    const answer = await ask({ zip: "906" });
    expect(answer.body["inCalifornia"]).toBe(false);
    expect(answer.body["reason"]).toBe("malformed");
    expect(String(answer.mode("shipping").message)).toContain("five digit");
  });

  it("asks for a ZIP when none was sent", async () => {
    const response = await handleCheckDeliveryZone(
      postJson("/api/check-delivery-zone", {}),
      deps(),
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toMatchObject({ code: "zip-missing" });
  });

  it("refuses a body that is not an object", async () => {
    const response = await handleCheckDeliveryZone(
      postJson("/api/check-delivery-zone", ["90630"]),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("answers a GET, for a link somebody can paste", async () => {
    const response = await handleCheckDeliveryZone(
      new Request("https://hakopsbakery.com/api/check-delivery-zone?zip=90630"),
      deps(),
    );
    expect(response.status).toBe(200);
    expect((await readBody(response))["inCalifornia"]).toBe(true);
  });

  it("refuses a method it does not answer", async () => {
    const response = await handleCheckDeliveryZone(
      new Request("https://hakopsbakery.com/api/check-delivery-zone", { method: "DELETE" }),
      deps(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("rate limits a flood from one address", async () => {
    const shared = deps();
    let last = new Response();
    for (let attempt = 0; attempt < 70; attempt += 1) {
      last = await handleCheckDeliveryZone(
        postJson(
          "/api/check-delivery-zone",
          { zip: "90630" },
          { "x-nf-client-connection-ip": "203.0.113.9" },
        ),
        shared,
      );
    }
    expect(last.status).toBe(429);
  });
});

describe("the configured delivery area", () => {
  it("contains only California ZIPs", async () => {
    /*
      A typo in the delivery list would let somebody outside the state order
      a delivery, which the state gate would then have to catch. Better to
      catch it here.
    */
    const configured = fulfillmentConfigFromEnv().delivery.zips;
    expect(configured.length).toBeGreaterThan(0);
    for (const zip of configured) {
      const answer = await ask({ zip });
      expect(answer.body["inCalifornia"]).toBe(true);
    }
  });
});
