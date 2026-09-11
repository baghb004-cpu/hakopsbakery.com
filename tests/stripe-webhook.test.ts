/**
 * stripe-webhook.
 *
 * Signature verification here is the real Stripe SDK, not a fake. A fake
 * verifier would pass whatever the webhook did, including nothing, and
 * getting verification wrong is the single most common bug in webhook code.
 */

import { describe, expect, it } from "vitest";
import { californiaGate, handleStripeWebhook } from "../netlify/functions/stripe-webhook";
import type { WebhookDeps } from "../netlify/functions/stripe-webhook";
import { signWebhookPayload } from "../netlify/functions/_shared/stripe-gateway";
import type { OrderStore } from "../netlify/functions/_shared/store";
import {
  FRIDAY_MORNING,
  OPEN_BAKE_DATE,
  harness,
  postRaw,
  readBody,
  testCompliance,
  testFulfillment,
  testSettings,
} from "./function-harness";

const SECRET = "whsec_test_only_never_a_real_secret";

/* ------------------------------------------------------------------ */
/* Building a delivery                                                 */
/* ------------------------------------------------------------------ */

interface AddressFixture {
  line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

const CYPRESS: AddressFixture = {
  line1: "1 Example Street",
  city: "Cypress",
  state: "CA",
  postal_code: "90630",
  country: "US",
};

const LAS_VEGAS: AddressFixture = {
  line1: "1 Example Street",
  city: "Las Vegas",
  state: "NV",
  postal_code: "89101",
  country: "US",
};

interface SessionFixture {
  readonly id?: string;
  readonly mode?: string;
  readonly shipping?: AddressFixture | null;
  readonly legacyShipping?: AddressFixture | null;
  readonly billing?: AddressFixture | null;
  readonly paymentStatus?: string;
  readonly paymentIntent?: string | null;
  readonly metadata?: Record<string, string> | null;
  readonly amounts?: { subtotal: number; shipping: number; tax: number; total: number };
}

function session(fixture: SessionFixture = {}): Record<string, unknown> {
  const amounts = fixture.amounts ?? { subtotal: 5200, shipping: 1200, tax: 455, total: 6855 };
  const mode = fixture.mode ?? "shipping";

  return {
    id: fixture.id ?? "cs_test_0001",
    object: "checkout.session",
    payment_status: fixture.paymentStatus ?? "paid",
    payment_intent: fixture.paymentIntent === undefined ? "pi_test_0001" : fixture.paymentIntent,
    amount_subtotal: amounts.subtotal,
    amount_total: amounts.total,
    total_details: {
      amount_discount: 0,
      amount_shipping: amounts.shipping,
      amount_tax: amounts.tax,
    },
    customer_details: {
      email: "customer@example.com",
      name: "A Customer",
      address: fixture.billing === undefined ? CYPRESS : fixture.billing,
    },
    collected_information:
      fixture.shipping === null
        ? { shipping_details: null }
        : { shipping_details: { name: "A Customer", address: fixture.shipping ?? CYPRESS } },
    ...(fixture.legacyShipping === undefined
      ? {}
      : { shipping_details: { name: "A Customer", address: fixture.legacyShipping } }),
    consent: { terms_of_service: "accepted" },
    metadata:
      fixture.metadata === undefined
        ? {
            orderRef: "HB-ABCDEF0123",
            holdId: "hold_abcdef",
            bakeDate: OPEN_BAKE_DATE,
            fulfillmentMode: mode,
            fulfillmentZip: "90630",
            fulfillmentFeeCents: String(amounts.shipping),
            subtotalCents: String(amounts.subtotal),
            piecesTotal: "24",
            lines: "HB-TEST-01:full-tray:1",
            consentVersion: "2026-09-11.a",
            consentAt: FRIDAY_MORNING.toISOString(),
            cfoCounty: "Orange County",
            cfoRegistration: "CFO-TEST-0001",
          }
        : fixture.metadata,
  };
}

function event(
  type: string,
  object: Record<string, unknown>,
  id = "evt_test_0001",
): Record<string, unknown> {
  return {
    id,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: Math.floor(FRIDAY_MORNING.getTime() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

function delivery(payload: Record<string, unknown>, secret = SECRET): Request {
  const body = JSON.stringify(payload);
  return postRaw("/api/stripe-webhook", body, {
    "stripe-signature": signWebhookPayload(body, secret),
  });
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  const bench = harness();
  return {
    now: () => FRIDAY_MORNING,
    store: bench.store,
    stripe: bench.stripe,
    emailer: bench.emailer,
    fulfillment: testFulfillment(),
    settings: testSettings(),
    compliance: testCompliance(),
    webhookSecret: SECRET,
    logger: bench.logger,
    ...overrides,
  };
}

async function withHold(bench: WebhookDeps): Promise<void> {
  await bench.store.reserve({
    holdId: "hold_abcdef",
    bakeDate: OPEN_BAKE_DATE,
    pieces: 24,
    capacityPieces: 48,
    orderRef: "HB-ABCDEF0123",
    expiresAt: FRIDAY_MORNING.getTime() + 1_800_000,
    now: FRIDAY_MORNING.getTime(),
  });
}

type Bench = ReturnType<typeof harness>;

/* ------------------------------------------------------------------ */

describe("signature verification", () => {
  it("rejects a body with no signature header at all", async () => {
    const bench = deps();
    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", JSON.stringify(event("checkout.session.completed", session()))),
      bench,
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toBe("signature-missing");
    expect((bench.store as Bench["store"]).state.orders.size).toBe(0);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const bench = deps();
    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session()), "whsec_a_different_secret"),
      bench,
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toBe("signature-invalid");
    expect((bench.store as Bench["store"]).state.orders.size).toBe(0);
    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(0);
  });

  it("rejects a signature header that is simply made up", async () => {
    const body = JSON.stringify(event("checkout.session.completed", session()));
    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", body, { "stripe-signature": "t=1,v1=deadbeef" }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a replay whose timestamp is outside the tolerance", async () => {
    const body = JSON.stringify(event("checkout.session.completed", session()));
    const ancient = Math.floor(Date.now() / 1000) - 60 * 60;
    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", body, {
        "stripe-signature": signWebhookPayload(body, SECRET, ancient),
      }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a body that was re-serialized after being signed", async () => {
    /*
      The classic bug, demonstrated. The signature covers the exact bytes, so
      parsing the JSON and stringifying it again, even with identical
      content, breaks verification. Any code that verifies against a
      re-serialized body is verifying nothing.
    */
    const payload = event("checkout.session.completed", session());
    const signedBytes = JSON.stringify(payload, null, 2);
    const resentBytes = JSON.stringify(JSON.parse(signedBytes));
    expect(resentBytes).not.toBe(signedBytes);

    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", resentBytes, {
        "stripe-signature": signWebhookPayload(signedBytes, SECRET),
      }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("accepts a genuinely signed delivery", async () => {
    const bench = deps();
    await withHold(bench);
    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session({ shipping: CYPRESS }))),
      bench,
    );
    expect(response.status).toBe(200);
    expect((await readBody(response))["received"]).toBe(true);
  });

  it("refuses to accept anything when the signing secret is not configured", async () => {
    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session())),
      deps({ webhookSecret: null }),
    );
    expect(response.status).toBe(500);
  });
});

describe("the final address check, brief section 8 step 5", () => {
  it("records the order when the final address is in California", async () => {
    const bench = deps();
    await withHold(bench);

    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session({ shipping: CYPRESS }))),
      bench,
    );
    expect(response.status).toBe(200);

    const store = bench.store as Bench["store"];
    const order = store.state.orders.get("cs_test_0001");
    expect(order?.status).toBe("paid");
    expect(order?.zip).toBe("90630");
    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(0);
    /* The hold becomes a commitment rather than expiring. */
    expect(store.state.holds.get("hold_abcdef")?.confirmed).toBe(true);
  });

  it("refunds an address changed to another state inside Stripe Checkout", async () => {
    const bench = deps();
    await withHold(bench);

    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session({ shipping: LAS_VEGAS }))),
      bench,
    );
    expect(response.status).toBe(200);

    const stripe = bench.stripe as Bench["stripe"];
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]?.params.payment_intent).toBe("pi_test_0001");
    expect(stripe.refunds[0]?.params.metadata).toMatchObject({ reason: "outside-california" });

    const store = bench.store as Bench["store"];
    expect(store.state.orders.get("cs_test_0001")?.status).toBe("refunded-out-of-state");
    /* A refunded order is not revenue and must not move the annual meter. */
    expect(store.state.orders.get("cs_test_0001")?.capContributionCents).toBe(0);
    /* The bake day is handed back. */
    expect(store.state.holds.has("hold_abcdef")).toBe(false);

    const flags = store.state.flags;
    expect(flags.some((flag) => flag.code === "refunded-out-of-state")).toBe(true);

    const emails = (bench.emailer as Bench["emailer"]).sent;
    const toCustomer = emails.find((message) => message.to === "customer@example.com");
    expect(toCustomer?.text).toContain("outside California");
    expect(toCustomer?.text).toContain("refunded");
    expect(emails.some((message) => message.to === "orders@hakopsbakery.com")).toBe(true);
  });

  it("checks the address where older API versions put it", async () => {
    /*
      A webhook endpoint pinned to an older API version delivers the final
      address at shipping_details rather than collected_information. Reading
      only the current location would find nothing here and let a Nevada
      address through.
    */
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({ shipping: null, legacyShipping: LAS_VEGAS, billing: LAS_VEGAS }),
        ),
      ),
      bench,
    );

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
  });

  it("fails closed when a shipping order arrives with no address at all", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({ mode: "shipping", shipping: null, billing: null }),
        ),
      ),
      bench,
    );

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
    const store = bench.store as Bench["store"];
    expect(store.state.flags.some((flag) => flag.detail.includes("address-missing"))).toBe(true);
  });

  it("refunds a California state field paired with an out of state ZIP", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({ shipping: { ...LAS_VEGAS, state: "CA" } }),
        ),
      ),
      bench,
    );

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
    const flags = (bench.store as Bench["store"]).state.flags;
    expect(flags.some((flag) => flag.detail.includes("zip-not-california"))).toBe(true);
  });

  it("refunds an address outside the United States", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({
            shipping: { ...CYPRESS, country: "CA", state: "BC", postal_code: "V6B 1A1" },
          }),
        ),
      ),
      bench,
    );

    /* "CA" as a country is Canada, not California. */
    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
  });

  it("refunds a delivery to a California ZIP outside the delivery run", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({
            mode: "delivery",
            shipping: { ...CYPRESS, city: "Sacramento", postal_code: "95814" },
          }),
        ),
      ),
      bench,
    );

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
  });

  it("does not refund a pickup order billed to another state", async () => {
    /*
      The sale happens at the door in Cypress. Somebody visiting from Nevada
      may collect a tray, and refunding them would be wrong.
    */
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event(
          "checkout.session.completed",
          session({ mode: "pickup", shipping: null, billing: LAS_VEGAS }),
        ),
      ),
      bench,
    );

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(0);
    expect((bench.store as Bench["store"]).state.orders.get("cs_test_0001")?.status).toBe("paid");
  });

  it("flags loudly, and does not silently give up, when the refund itself fails", async () => {
    const bench = deps();
    await withHold(bench);
    (bench.stripe as Bench["stripe"]).failNextRefundWith(new Error("card_declined_on_refund"));

    const response = await handleStripeWebhook(
      delivery(event("checkout.session.completed", session({ shipping: LAS_VEGAS }))),
      bench,
    );

    expect(response.status).toBe(200);
    const store = bench.store as Bench["store"];
    expect(store.state.orders.get("cs_test_0001")?.status).toBe("refund-failed");
    expect(store.state.flags.some((flag) => flag.code === "refund-failed")).toBe(true);

    const admin = (bench.emailer as Bench["emailer"]).sent.find((message) =>
      message.subject.includes("ACTION NEEDED"),
    );
    expect(admin?.text).toContain("by hand");
  });
});

describe("the gate as a function", () => {
  it("answers the same way for every shape it can be handed", () => {
    const config = testFulfillment();

    expect(
      californiaGate({ id: "cs", collected_information: { shipping_details: { address: CYPRESS } } }, "shipping", config),
    ).toMatchObject({ ok: true, zip: "90630", checked: true });

    expect(
      californiaGate({ id: "cs", collected_information: { shipping_details: { address: LAS_VEGAS } } }, "shipping", config),
    ).toMatchObject({ ok: false, code: "state-not-california" });

    /* No metadata and no address: nothing to check, and the caller flags it. */
    expect(californiaGate({ id: "cs" }, null, config)).toMatchObject({ ok: true, checked: false });

    /* No metadata but an address that is plainly out of state: refused. */
    expect(
      californiaGate({ id: "cs", shipping_details: { address: LAS_VEGAS } }, null, config),
    ).toMatchObject({ ok: false });
  });
});

describe("idempotency", () => {
  it("handles the same event id arriving twice without a second order", async () => {
    const bench = deps();
    await withHold(bench);
    const payload = event("checkout.session.completed", session({ shipping: CYPRESS }));

    const first = await handleStripeWebhook(delivery(payload), bench);
    const second = await handleStripeWebhook(delivery(payload), bench);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await readBody(second))["duplicate"]).toBe(true);

    const store = bench.store as Bench["store"];
    expect(store.state.orders.size).toBe(1);
    expect(store.state.consents).toHaveLength(1);
  });

  it("does not refund twice when an out of state event is retried", async () => {
    const bench = deps();
    await withHold(bench);
    const payload = event("checkout.session.completed", session({ shipping: LAS_VEGAS }));

    await handleStripeWebhook(delivery(payload), bench);
    await handleStripeWebhook(delivery(payload), bench);

    expect((bench.stripe as Bench["stripe"]).refunds).toHaveLength(1);
    expect((bench.store as Bench["store"]).state.orders.size).toBe(1);
  });

  it("does not create a second order when a different event id carries the same session", async () => {
    const bench = deps();
    await withHold(bench);
    const object = session({ shipping: CYPRESS });

    await handleStripeWebhook(delivery(event("checkout.session.completed", object, "evt_a")), bench);
    await handleStripeWebhook(delivery(event("checkout.session.completed", object, "evt_b")), bench);

    expect((bench.store as Bench["store"]).state.orders.size).toBe(1);
  });

  it("gives the event id back when the handler fails, so a retry is real work", async () => {
    const bench = deps();
    await withHold(bench);
    const real = bench.store as Bench["store"];

    let failOnce = true;
    const flaky: OrderStore = {
      ...real,
      async recordOrder(order) {
        if (failOnce) {
          failOnce = false;
          throw new Error("the database was having a moment");
        }
        await real.recordOrder(order);
      },
    };

    const payload = event("checkout.session.completed", session({ shipping: CYPRESS }));
    const first = await handleStripeWebhook(delivery(payload), deps({ store: flaky }));
    expect(first.status).toBe(500);
    expect(real.state.orders.size).toBe(0);

    /* Stripe retries. This time it works, and it is treated as new work. */
    const second = await handleStripeWebhook(delivery(payload), deps({ store: flaky }));
    expect(second.status).toBe(200);
    expect(real.state.orders.size).toBe(1);
  });
});

describe("the other events", () => {
  it("gives the capacity back when a session expires unpaid", async () => {
    const bench = deps();
    await withHold(bench);
    const store = bench.store as Bench["store"];
    expect(store.state.holds.size).toBe(1);

    await handleStripeWebhook(
      delivery(event("checkout.session.expired", session(), "evt_expired")),
      bench,
    );

    expect(store.state.holds.size).toBe(0);
  });

  it("waits for a delayed payment rather than confirming it early", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(
        event("checkout.session.completed", session({ paymentStatus: "unpaid" }), "evt_unpaid"),
      ),
      bench,
    );

    const store = bench.store as Bench["store"];
    expect(store.state.orders.size).toBe(0);
    /* The hold is still there, so the capacity is not given away meanwhile. */
    expect(store.state.holds.get("hold_abcdef")?.confirmed).toBe(false);
    expect(store.state.holds.size).toBe(1);
  });

  it("ignores an event type it has no opinion about", async () => {
    const response = await handleStripeWebhook(
      delivery(event("customer.created", { id: "cus_test" }, "evt_other")),
      deps(),
    );
    expect(response.status).toBe(200);
  });

  it("flags a completed session this site did not create", async () => {
    const bench = deps();
    await handleStripeWebhook(
      delivery(
        event("checkout.session.completed", session({ metadata: null, shipping: CYPRESS })),
      ),
      bench,
    );
    const flags = (bench.store as Bench["store"]).state.flags;
    expect(flags.some((flag) => flag.code === "session-without-metadata")).toBe(true);
  });
});

describe("consent evidence", () => {
  it("records the wording, the version and what Stripe collected", async () => {
    const bench = deps();
    await withHold(bench);

    await handleStripeWebhook(
      delivery(event("checkout.session.completed", session({ shipping: CYPRESS }))),
      bench,
    );

    const consent = (bench.store as Bench["store"]).state.consents[0];
    expect(consent).toBeDefined();
    expect(consent?.orderRef).toBe("HB-ABCDEF0123");
    expect(consent?.version).toBe("2026-09-11.a");
    expect(consent?.statement).toContain("not inspected by the Department of Public Health");
    expect(consent?.stripeTermsOfService).toBe("accepted");
    expect(consent?.registrationNumber).toBe("CFO-TEST-0001");
    expect(consent?.source).toBe("webhook");
  });
});
