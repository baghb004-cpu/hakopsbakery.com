/**
 * The Class A annual gross sales ceiling.
 *
 * Product revenue plus shipping revenue count toward it. Sales tax collected
 * does not: it was never revenue, it is money held for the state, and
 * counting it would close the shop early for no reason. Section 4 and
 * Section 12 of docs/BRIEF.md.
 */

import { describe, expect, it } from "vitest";
import {
  capContribution,
  capContributionFromSession,
  capMeter,
  sessionAmounts,
} from "../netlify/functions/_shared/cap";
import { handleStripeWebhook } from "../netlify/functions/stripe-webhook";
import { signWebhookPayload } from "../netlify/functions/_shared/stripe-gateway";
import {
  FRIDAY_MORNING,
  OPEN_BAKE_DATE,
  harness,
  postRaw,
  testCompliance,
  testFulfillment,
  testSettings,
} from "./function-harness";

/* A tray at 52 dollars, shipping at 12, tax at 4.55. */
const SESSION = {
  id: "cs_test_cap",
  amount_subtotal: 5200,
  amount_total: 6855,
  total_details: { amount_discount: 0, amount_shipping: 1200, amount_tax: 455 },
};

describe("what counts toward the ceiling", () => {
  it("counts product and shipping and excludes tax", () => {
    const result = capContributionFromSession(SESSION);
    expect(result.capContributionCents).toBe(6400);
    expect(result.capContributionCents).toBe(5200 + 1200);
    /* Stated the other way round, because this is the part that matters. */
    expect(result.capContributionCents).toBe(SESSION.amount_total - 455);
    expect(result.amountTaxCents).toBe(455);
    expect(result.consistent).toBe(true);
  });

  it("does not quietly leave shipping out", () => {
    const withoutShipping = capContributionFromSession({
      amount_subtotal: 5200,
      amount_total: 5655,
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 455 },
    });
    expect(withoutShipping.capContributionCents).toBe(5200);
    /* Shipping is the difference between the two, to the cent. */
    expect(capContributionFromSession(SESSION).capContributionCents - withoutShipping.capContributionCents).toBe(
      1200,
    );
  });

  it("takes a discount off before counting", () => {
    const result = capContribution({
      amountSubtotalCents: 5200,
      amountDiscountCents: 700,
      amountShippingCents: 1200,
      amountTaxCents: 394,
      amountTotalCents: 6094,
    });
    expect(result.capContributionCents).toBe(5700);
    expect(result.consistent).toBe(true);
  });

  it("notices when Stripe's total and Stripe's breakdown disagree", () => {
    const result = capContribution({
      amountSubtotalCents: 5200,
      amountDiscountCents: 0,
      amountShippingCents: 1200,
      amountTaxCents: 455,
      /* One cent adrift, which should be impossible. */
      amountTotalCents: 6856,
    });
    expect(result.consistent).toBe(false);
    expect(result.capContributionCents).toBe(6401);
    expect(result.crossCheckCents).toBe(6400);
  });

  it("reads a session with fields missing without falling over", () => {
    expect(sessionAmounts({}).amountTotalCents).toBe(0);
    expect(capContributionFromSession(null).capContributionCents).toBe(0);
    expect(capContributionFromSession(undefined).capContributionCents).toBe(0);
  });

  it("falls back to the shipping cost object on an older payload", () => {
    const amounts = sessionAmounts({
      amount_total: 6855,
      amount_subtotal: 5200,
      total_details: { amount_tax: 455, amount_discount: 0, amount_shipping: null },
      shipping_cost: { amount_subtotal: 1200, amount_tax: 0, amount_total: 1200 },
    });
    expect(amounts.amountShippingCents).toBe(1200);
    expect(capContribution(amounts).capContributionCents).toBe(6400);
  });
});

describe("the meter", () => {
  const cap = 8_600_000;

  it("is quiet below seventy percent", () => {
    expect(capMeter(5_000_000, cap).level).toBe("ok");
  });

  it("warns at seventy", () => {
    expect(capMeter(6_020_000, cap).level).toBe("warn");
  });

  it("warns loudly at eighty five", () => {
    expect(capMeter(7_310_000, cap).level).toBe("loud");
  });

  it("says so plainly once the ceiling is crossed", () => {
    const meter = capMeter(8_600_000, cap);
    expect(meter.level).toBe("over");
    expect(meter.remainingCents).toBe(0);
  });

  it("does not divide by a ceiling of zero", () => {
    expect(capMeter(1000, 0).fraction).toBe(0);
    expect(capMeter(1000, 0).level).toBe("ok");
  });
});

describe("through the webhook", () => {
  it("records the contribution with the tax taken off", async () => {
    const bench = harness();
    const secret = "whsec_test_cap";

    const payload = {
      id: "evt_cap_0001",
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(FRIDAY_MORNING.getTime() / 1000),
      data: {
        object: {
          ...SESSION,
          payment_status: "paid",
          payment_intent: "pi_cap_0001",
          customer_details: {
            email: "customer@example.com",
            address: {
              line1: "1 Example Street",
              city: "Cypress",
              state: "CA",
              postal_code: "90630",
              country: "US",
            },
          },
          collected_information: {
            shipping_details: {
              name: "A Customer",
              address: {
                line1: "1 Example Street",
                city: "Cypress",
                state: "CA",
                postal_code: "90630",
                country: "US",
              },
            },
          },
          metadata: {
            orderRef: "HB-CAP000001",
            holdId: "hold_cap",
            bakeDate: OPEN_BAKE_DATE,
            fulfillmentMode: "shipping",
            piecesTotal: "24",
            lines: "HB-TEST-01:full-tray:1",
          },
        },
      },
    };

    const body = JSON.stringify(payload);
    const response = await handleStripeWebhook(
      postRaw("/api/stripe-webhook", body, { "stripe-signature": signWebhookPayload(body, secret) }),
      {
        now: () => FRIDAY_MORNING,
        store: bench.store,
        stripe: bench.stripe,
        emailer: bench.emailer,
        fulfillment: testFulfillment(),
        settings: testSettings(),
        compliance: testCompliance(),
        webhookSecret: secret,
        logger: bench.logger,
      },
    );

    expect(response.status).toBe(200);
    const order = bench.store.state.orders.get("cs_test_cap");
    expect(order?.amountTotalCents).toBe(6855);
    expect(order?.amountTaxCents).toBe(455);
    expect(order?.capContributionCents).toBe(6400);

    const yearToDate = await bench.store.capTotalCents(FRIDAY_MORNING.getUTCFullYear());
    expect(yearToDate).toBe(6400);
  });
});
