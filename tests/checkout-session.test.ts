/**
 * create-checkout-session.
 *
 * The brief: "It is the only part of this site where a bug costs money or
 * creates a compliance problem." These are the cases that would.
 */

import { describe, expect, it } from "vitest";
import {
  buildSessionParams,
  handleCreateCheckoutSession,
} from "../netlify/functions/create-checkout-session";
import type { CheckoutDeps } from "../netlify/functions/create-checkout-session";
import { loadServerCatalog, resolveLines } from "../netlify/functions/_shared/catalog-server";
import { DISCLOSURE_VERSION } from "../netlify/functions/_shared/env";
import { createMemoryOrderStore } from "../netlify/functions/_shared/store";
import type { OrderStore } from "../netlify/functions/_shared/store";
import type { Stripe } from "../netlify/functions/_shared/stripe-gateway";
import {
  FRIDAY_MORNING,
  OPEN_BAKE_DATE,
  harness,
  postJson,
  readBody,
  testCatalog,
  testCompliance,
  testFulfillment,
  testSchedule,
  testSettings,
} from "./function-harness";

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function deps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  const bench = harness();
  return {
    now: () => FRIDAY_MORNING,
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
    ...overrides,
  };
}

interface OrderBody {
  readonly lines: unknown[];
  readonly fulfillment: Record<string, unknown>;
  readonly consent: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function order(overrides: Partial<OrderBody> = {}): OrderBody {
  return {
    lines: [{ sku: "HB-TEST-01", variantId: "full-tray", qty: 1 }],
    fulfillment: { mode: "pickup", zip: null, bakeDate: OPEN_BAKE_DATE, slotId: null },
    consent: { accepted: true, version: DISCLOSURE_VERSION },
    ...overrides,
  };
}

function post(body: unknown): Request {
  return postJson("/api/create-checkout-session", body);
}

/**
 * Stripe types a custom_text slot as the object or the empty string, because
 * an empty string is how a slot is cleared. Reach for the message through a
 * guard rather than an assertion.
 */
function customText(slot: { message?: string } | "" | null | undefined): string {
  return typeof slot === "object" && slot !== null ? String(slot.message ?? "") : "";
}

function lineItems(
  params: Stripe.Checkout.SessionCreateParams,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return [...(params.line_items ?? [])];
}

function firstLineItem(
  params: Stripe.Checkout.SessionCreateParams,
): Stripe.Checkout.SessionCreateParams.LineItem {
  const first = lineItems(params)[0];
  if (first === undefined) throw new Error("The session carried no line items.");
  return first;
}

/* ------------------------------------------------------------------ */

describe("the browser never sets a price", () => {
  it("ignores every price shaped field a crafted request can carry", async () => {
    const bench = deps();
    const response = await handleCreateCheckoutSession(
      post(
        order({
          /* None of this survives the request schema. */
          lines: [
            {
              sku: "HB-TEST-01",
              variantId: "full-tray",
              qty: 1,
              priceCents: 1,
              price: 1,
              unitAmount: 1,
              amount: 1,
              stripePriceId: "price_attacker",
            },
          ],
          subtotalCents: 1,
          totalCents: 1,
          discountCents: 5200,
          currency: "eur",
          fulfillmentFeeCents: 0,
        }),
      ),
      bench,
    );

    expect(response.status).toBe(200);

    const created = bench.stripe as ReturnType<typeof harness>["stripe"];
    expect(created.sessions).toHaveLength(1);
    const params = created.sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");

    const item = firstLineItem(params);
    /* The catalog price for a full tray, not the 1 cent that was sent. */
    expect(item.price_data?.unit_amount).toBe(5200);
    expect(item.price_data?.currency).toBe("usd");
    expect(item.price).toBeUndefined();
    expect(params.metadata?.["subtotalCents"]).toBe("5200");
    expect(params.currency).toBe("usd");

    const body = await readBody(response);
    expect(body["subtotalCents"]).toBe(5200);
  });

  it("charges the catalog price for each unit, times the quantity", async () => {
    const bench = deps();
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-01", variantId: "half-tray", qty: 2 }] })),
      bench,
    );
    expect(response.status).toBe(200);

    const params = (bench.stripe as ReturnType<typeof harness>["stripe"]).sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");
    const item = firstLineItem(params);
    expect(item.price_data?.unit_amount).toBe(2800);
    expect(item.quantity).toBe(2);
    expect(params.metadata?.["subtotalCents"]).toBe("5600");
  });

  it("refuses a quantity outside the allowed range", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-01", variantId: "full-tray", qty: 999 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "quantity-out-of-range" });
  });

  it("refuses a negative quantity rather than crediting the customer", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-01", variantId: "full-tray", qty: -3 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "quantity-out-of-range" });
  });
});

describe("the California gate, before checkout", () => {
  it("refuses a ZIP outside California for shipping", async () => {
    const response = await handleCreateCheckoutSession(
      post(
        order({
          fulfillment: { mode: "shipping", zip: "89101", bakeDate: OPEN_BAKE_DATE, slotId: null },
        }),
      ),
      deps(),
    );

    expect(response.status).toBe(409);
    const body = await readBody(response);
    expect(body["error"]).toMatchObject({ code: "out-of-state" });
    expect(String((body["error"] as Record<string, unknown>)["message"])).toContain("California");
  });

  it("refuses a California ZIP that is outside the delivery run", async () => {
    const response = await handleCreateCheckoutSession(
      post(
        order({
          fulfillment: { mode: "delivery", zip: "95814", bakeDate: OPEN_BAKE_DATE, slotId: null },
        }),
      ),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "outside-delivery-area" });
  });

  it("refuses a delivery under the minimum, with the shortfall", async () => {
    const response = await handleCreateCheckoutSession(
      post(
        order({
          lines: [{ sku: "HB-TEST-01", variantId: "half-tray", qty: 1 }],
          fulfillment: { mode: "delivery", zip: "90630", bakeDate: OPEN_BAKE_DATE, slotId: null },
        }),
      ),
      deps({ fulfillment: testFulfillment({ delivery: { available: true, feeCents: 500, minimumOrderCents: 4000, zips: ["90630"] } }) }),
    );
    expect(response.status).toBe(409);
    const body = await readBody(response);
    expect(body["error"]).toMatchObject({ code: "below-minimum", shortfallCents: 1200 });
  });
});

describe("the session Stripe is asked for", () => {
  it("locks the country list, restates California, and turns on tax", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(
      post(
        order({
          fulfillment: { mode: "shipping", zip: "95814", bakeDate: OPEN_BAKE_DATE, slotId: null },
        }),
      ),
      bench,
    );

    const params = (bench.stripe as ReturnType<typeof harness>["stripe"]).sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");

    expect(params.shipping_address_collection?.allowed_countries).toEqual(["US"]);
    expect(params.custom_text?.shipping_address).toBeTruthy();
    expect(customText(params.custom_text?.shipping_address)).toContain("California");

    expect(params.automatic_tax?.enabled).toBe(true);
    expect(params.billing_address_collection).toBe("required");
    expect(firstLineItem(params).price_data?.product_data?.tax_code).toBe("txcd_40060003");
    expect(firstLineItem(params).price_data?.tax_behavior).toBe("exclusive");
  });

  it("collects consent through Stripe as a second layer", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(post(order()), bench);
    const params = (bench.stripe as ReturnType<typeof harness>["stripe"]).sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");

    expect(params.consent_collection?.terms_of_service).toBe("required");
    expect(customText(params.custom_text?.terms_of_service_acceptance)).toContain(
      "Made in a home kitchen",
    );
    expect(params.metadata?.["consentVersion"]).toBe(DISCLOSURE_VERSION);
  });

  it("records the site's own consent, which is the primary evidence", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(post(order()), bench);
    const store = bench.store as ReturnType<typeof harness>["store"];
    expect(store.state.consents).toHaveLength(1);
    expect(store.state.consents[0]).toMatchObject({
      source: "checkout",
      version: DISCLOSURE_VERSION,
    });
    expect(store.state.consents[0]?.statement).toContain(
      "not inspected by the Department of Public Health",
    );
  });

  it("charges the fulfillment fee as a shipping line the server chose", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(
      post(
        order({
          fulfillment: { mode: "shipping", zip: "95814", bakeDate: OPEN_BAKE_DATE, slotId: null },
        }),
      ),
      bench,
    );
    const params = (bench.stripe as ReturnType<typeof harness>["stripe"]).sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");
    const option = (params.shipping_options ?? [])[0];
    expect(option?.shipping_rate_data?.fixed_amount?.amount).toBe(1200);
    expect(option?.shipping_rate_data?.tax_code).toBe("txcd_92010001");
  });

  it("does not let the quantity be changed once capacity is held", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(post(order()), bench);
    const params = (bench.stripe as ReturnType<typeof harness>["stripe"]).sessions[0]?.params;
    if (params === undefined) throw new Error("no session was created");
    expect(firstLineItem(params).adjustable_quantity?.enabled).toBe(false);
  });

  it("sets an idempotency key that is stable for one attempt", async () => {
    const bench = deps();
    const first = await handleCreateCheckoutSession(post(order({ requestId: "attempt-0001" })), bench);
    const second = await handleCreateCheckoutSession(post(order({ requestId: "attempt-0001" })), bench);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const stripe = bench.stripe as ReturnType<typeof harness>["stripe"];
    /* One create, because the second carried the same key. */
    expect(stripe.sessions).toHaveLength(1);
    expect((await readBody(first))["sessionId"]).toBe((await readBody(second))["sessionId"]);
  });

  it("still opens a checkout when the customer comes back and tries again", async () => {
    /*
      The session expiry Stripe is sent has to be at least thirty minutes
      ahead of the moment the session is created, so it necessarily moves
      between one attempt and the next. A key tied to the attempt alone would
      be reused with different parameters, Stripe would refuse it, and the
      customer would be unable to pay for as long as Stripe remembers the
      key. The capacity must still be claimed once, and must still be held.
    */
    const bench = harness();
    let clock = FRIDAY_MORNING.getTime();
    const bench2 = deps({
      store: bench.store,
      stripe: bench.stripe,
      rateLimiter: bench.rateLimiter,
      logger: bench.logger,
      now: () => new Date(clock),
    });

    const first = await handleCreateCheckoutSession(post(order({ requestId: "attempt-0003" })), bench2);
    expect(first.status).toBe(200);

    clock += 90_000;
    const second = await handleCreateCheckoutSession(post(order({ requestId: "attempt-0003" })), bench2);
    expect(second.status).toBe(200);
    expect(typeof (await readBody(second))["url"]).toBe("string");

    /* One hold, and it is still there rather than released by the retry. */
    expect(bench.store.state.holds.size).toBe(1);
    const hold = [...bench.store.state.holds.values()][0];
    expect(hold).toBeDefined();
    /* The hold outlives the session the retry created, or somebody could pay
       for capacity that has already been handed to the next customer. */
    expect(hold?.expiresAt).toBeGreaterThanOrEqual(clock + 30 * 60_000);
  });

  it("keeps the capacity when Stripe refuses on the idempotency key", async () => {
    const bench = deps();
    const stripe = bench.stripe as ReturnType<typeof harness>["stripe"];
    const conflict = new Error("same key, other parameters") as Error & { type: string };
    conflict.type = "StripeIdempotencyError";
    stripe.failNextSessionWith(conflict);

    const response = await handleCreateCheckoutSession(post(order({ requestId: "attempt-0004" })), bench);

    expect(response.status).toBe(500);
    /* A session for this attempt already exists at Stripe and is payable.
       Releasing its capacity here would sell the bake day twice. */
    expect((bench.store as ReturnType<typeof harness>["store"]).state.holds.size).toBe(1);
  });

  it("does not let a retry claim the capacity twice", async () => {
    const bench = deps();
    await handleCreateCheckoutSession(post(order({ requestId: "attempt-0002" })), bench);
    await handleCreateCheckoutSession(post(order({ requestId: "attempt-0002" })), bench);

    const store = bench.store as ReturnType<typeof harness>["store"];
    expect(store.state.holds.size).toBe(1);
    const committed = await store.committedOrders(FRIDAY_MORNING.getTime());
    expect(committed).toHaveLength(1);
  });
});

describe("capacity", () => {
  it("refuses a sold out bake date at session creation", async () => {
    const bench = deps();
    const store = bench.store as ReturnType<typeof harness>["store"];

    /* Two batches of twenty four on that Sunday, all of it spoken for. */
    await store.reserve({
      holdId: "hold_existing",
      bakeDate: OPEN_BAKE_DATE,
      pieces: 48,
      capacityPieces: 48,
      orderRef: "HB-EXISTING",
      expiresAt: FRIDAY_MORNING.getTime() + 60_000,
      now: FRIDAY_MORNING.getTime(),
    });

    const response = await handleCreateCheckoutSession(post(order()), bench);

    expect(response.status).toBe(409);
    const body = await readBody(response);
    expect(body["error"]).toMatchObject({ code: "bake-date-sold-out" });
    /* And nothing reached Stripe. */
    expect((bench.stripe as ReturnType<typeof harness>["stripe"]).sessions).toHaveLength(0);
  });

  it("refuses the second of two people taking the last batch, even if the schedule read was stale", async () => {
    /*
      The check and the claim are two different moments. This store answers
      the availability read as though the date were empty, while the claim
      sees the truth, which is exactly what a race looks like from inside one
      request. The claim has to be the thing that decides.
    */
    const real = createMemoryOrderStore();
    await real.reserve({
      holdId: "hold_first_customer",
      bakeDate: OPEN_BAKE_DATE,
      pieces: 48,
      capacityPieces: 48,
      orderRef: "HB-FIRST",
      expiresAt: FRIDAY_MORNING.getTime() + 60_000,
      now: FRIDAY_MORNING.getTime(),
    });

    const stale: OrderStore = {
      ...real,
      durable: true,
      async committedOrders() {
        return [];
      },
    };

    const bench = deps({ store: stale });
    const response = await handleCreateCheckoutSession(post(order()), bench);

    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-sold-out" });
    expect((bench.stripe as ReturnType<typeof harness>["stripe"]).sessions).toHaveLength(0);
  });

  it("gives the capacity back when Stripe fails", async () => {
    const bench = deps();
    const stripe = bench.stripe as ReturnType<typeof harness>["stripe"];
    stripe.failNextSessionWith(new Error("Stripe is having a bad day, sk_live_should_never_appear"));

    const response = await handleCreateCheckoutSession(post(order()), bench);

    expect(response.status).toBe(500);
    const body = await readBody(response);
    const error = body["error"] as Record<string, unknown>;
    /* Nothing from the provider, and certainly not a key. */
    expect(JSON.stringify(body)).not.toContain("sk_live");
    expect(String(error["message"])).toContain("Nothing was charged");
    expect(String(error["reference"])).toMatch(/^ref_/);

    const store = bench.store as ReturnType<typeof harness>["store"];
    expect(store.state.holds.size).toBe(0);
  });
});

describe("bake dates", () => {
  it("refuses a Tuesday, because Hakop has class", async () => {
    /* 2026-09-15 is a Tuesday. */
    const response = await handleCreateCheckoutSession(
      post(order({ fulfillment: { mode: "pickup", zip: null, bakeDate: "2026-09-15", slotId: null } })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-unavailable" });
  });

  it("refuses a date whose cutoff has passed", async () => {
    /* From Friday morning, Saturday's cutoff was Thursday at eight. */
    const response = await handleCreateCheckoutSession(
      post(order({ fulfillment: { mode: "pickup", zip: null, bakeDate: "2026-09-12", slotId: null } })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-past-cutoff" });
  });

  it("refuses a blackout date", async () => {
    const response = await handleCreateCheckoutSession(
      post(order()),
      deps({ schedule: testSchedule({ blackoutDates: [OPEN_BAKE_DATE] }) }),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-blackout" });
  });

  it("refuses a date that is not a real calendar date", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ fulfillment: { mode: "pickup", zip: null, bakeDate: "2026-02-30", slotId: null } })),
      deps(),
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toMatchObject({ code: "bake-date-invalid" });
  });
});

describe("the gates around the whole thing", () => {
  it("takes no order while the store is closed", async () => {
    const response = await handleCreateCheckoutSession(post(order()), deps({ storeOpen: false }));
    expect(response.status).toBe(503);
    expect((await readBody(response))["error"]).toMatchObject({ code: "store-closed" });
  });

  it("takes no order when capacity cannot be held durably", async () => {
    const response = await handleCreateCheckoutSession(
      post(order()),
      deps({ store: createMemoryOrderStore() }),
    );
    expect(response.status).toBe(503);
    expect((await readBody(response))["error"]).toMatchObject({ code: "storage-not-configured" });
  });

  it("requires the home kitchen statement to be acknowledged", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ consent: { accepted: false, version: DISCLOSURE_VERSION } })),
      deps(),
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toMatchObject({ code: "consent-required" });
  });

  it("refuses consent recorded against wording that is no longer current", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ consent: { accepted: true, version: "2019-01-01.a" } })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "consent-version-stale" });
  });

  it("refuses anything but POST", async () => {
    const response = await handleCreateCheckoutSession(
      new Request("https://hakopsbakery.com/api/create-checkout-session"),
      deps(),
    );
    expect(response.status).toBe(405);
  });

  it("rate limits a flood from one address", async () => {
    const bench = deps();
    let last = new Response();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      last = await handleCreateCheckoutSession(
        postJson("/api/create-checkout-session", order({ requestId: `flood-${attempt}` }), {
          "x-nf-client-connection-ip": "203.0.113.7",
        }),
        bench,
      );
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).not.toBeNull();
  });
});

describe("catalog faults are refusals, not sales", () => {
  it("refuses a variant whose price is still a placeholder", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-01", variantId: "not-priced", qty: 1 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "placeholder-price" });
  });

  it("refuses a variant whose pieces have never been counted", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-01", variantId: "not-counted", qty: 1 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "pieces-not-counted" });
  });

  it("refuses a product that is not active", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-TEST-02", variantId: "full-tray", qty: 1 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "product-inactive" });
  });

  it("refuses a sku that does not exist", async () => {
    const response = await handleCreateCheckoutSession(
      post(order({ lines: [{ sku: "HB-NOPE-99", variantId: "full-tray", qty: 1 }] })),
      deps(),
    );
    expect(response.status).toBe(409);
    expect((await readBody(response))["error"]).toMatchObject({ code: "unknown-product" });
  });
});

describe("the real catalog on disk", () => {
  it("parses, and is deliberately not sellable yet", async () => {
    const catalog = await loadServerCatalog();
    const gata = catalog.find((product) => product.slug === "gata");
    expect(gata).toBeDefined();
    if (gata === undefined) return;

    const variant = gata.variants[0];
    expect(variant).toBeDefined();
    if (variant === undefined) return;

    const resolved = resolveLines(
      catalog,
      [{ sku: gata.sku, variantId: variant.id, qty: 1 }],
      { maxQtyPerLine: 20, defaultTaxCode: "txcd_40060003" },
    );

    /*
      Both tray prices carry pricingStatus "placeholder" (brief open decision
      5) and no piece count has been taken, so the shop cannot legitimately
      sell either one today. This test fails the day one of those is fixed,
      which is the reminder to fix the other and to update this expectation.
    */
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(["placeholder-price", "pieces-not-counted"]).toContain(resolved.code);
    }
  });
});

describe("buildSessionParams in isolation", () => {
  it("puts the order reference everywhere it will be needed later", () => {
    const resolved = resolveLines(
      testCatalog(),
      [{ sku: "HB-TEST-01", variantId: "full-tray", qty: 1 }],
      { maxQtyPerLine: 20, defaultTaxCode: "txcd_40060003" },
    );
    if (!resolved.ok) throw new Error("the fixture should resolve");

    const params = buildSessionParams({
      request: {
        lines: [{ sku: "HB-TEST-01", variantId: "full-tray", qty: 1 }],
        fulfillment: { mode: "pickup", zip: null, bakeDate: OPEN_BAKE_DATE, slotId: null },
        consent: { accepted: true, version: DISCLOSURE_VERSION },
        email: null,
        requestId: null,
      },
      resolved,
      fulfillment: { mode: "pickup", zip: null, feeCents: 0 },
      bakeDate: OPEN_BAKE_DATE,
      orderRef: "HB-ABCDEF0123",
      holdId: "hold_abc",
      settings: testSettings(),
      compliance: testCompliance(),
      expiresAtMs: FRIDAY_MORNING.getTime() + 1_800_000,
      successPath: "/order/confirmed/",
      cancelPath: "/cart/",
      consentAt: FRIDAY_MORNING.toISOString(),
    });

    expect(params.client_reference_id).toBe("HB-ABCDEF0123");
    expect(params.metadata?.["orderRef"]).toBe("HB-ABCDEF0123");
    expect(params.payment_intent_data?.metadata?.["orderRef"]).toBe("HB-ABCDEF0123");
    expect(params.metadata?.["holdId"]).toBe("hold_abc");
    expect(params.success_url).toContain("{CHECKOUT_SESSION_ID}");
    /* Pickup collects no shipping address, so there is nothing to restate. */
    expect(params.shipping_address_collection).toBeUndefined();
    expect(params.expires_at).toBe(Math.floor((FRIDAY_MORNING.getTime() + 1_800_000) / 1000));
  });
});
