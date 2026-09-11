/**
 * Shared scaffolding for the Netlify function tests.
 *
 * Not a test file: the vitest include pattern only picks up `*.test.ts`.
 *
 * Two things are deliberately NOT faked in here.
 *
 * Stripe signature verification is the real SDK, in every test that touches
 * the webhook. A fake verifier that always returns true would pass whatever
 * the webhook did, including nothing.
 *
 * The bake schedule, the California check and the fulfillment rules are the
 * real modules from `src/lib`. Faking those would test a copy of the logic
 * rather than the logic.
 */

import type { BakeScheduleConfig } from "@lib/bake-schedule";
import type { FulfillmentConfig } from "@lib/zones";
import type { ServerProduct } from "../netlify/functions/_shared/catalog-server";
import type { ShopSettings, ComplianceConfig } from "../netlify/functions/_shared/env";
import {
  CONSENT_ACKNOWLEDGEMENT,
  DISCLOSURE_VERSION,
  HOME_KITCHEN_STATEMENT,
} from "../netlify/functions/_shared/env";
import type { CreatedRefund, CreatedSession, Stripe } from "../netlify/functions/_shared/stripe-gateway";
import { createVerifyOnlyGateway } from "../netlify/functions/_shared/stripe-gateway";
import { createMemoryOrderStore } from "../netlify/functions/_shared/store";
import type { MemoryOrderStore } from "../netlify/functions/_shared/store";
import { createRecordingEmailer } from "../netlify/functions/_shared/email";
import type { RecordingEmailer } from "../netlify/functions/_shared/email";
import { createRateLimiter } from "../netlify/functions/_shared/rate-limit";
import { memoryLogger } from "../netlify/functions/_shared/http";

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://hakopsbakery.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A POST whose body is an exact string. Used where the bytes matter. */
export function postRaw(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://hakopsbakery.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

export async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/*
  A catalog written for the tests rather than the real one, because the real
  one is not sellable yet: both tray prices are marked placeholder and no
  piece count has been taken. tests/checkout-session.test.ts asserts that
  separately, against the real file, so the launch blocker stays visible.
*/
export function testCatalog(): ServerProduct[] {
  return [
    {
      sku: "HB-TEST-01",
      slug: "test-tray",
      name: "Test tray",
      active: true,
      leadTimeDays: 2,
      variants: [
        {
          id: "half-tray",
          label: "Half tray",
          priceCents: 2800,
          pricingStatus: "confirmed",
          piecesPerUnit: 12,
          netWeightGrams: null,
          stripePriceId: null,
        },
        {
          id: "full-tray",
          label: "Full tray",
          priceCents: 5200,
          pricingStatus: "confirmed",
          piecesPerUnit: 24,
          netWeightGrams: null,
          stripePriceId: null,
        },
        {
          id: "not-priced",
          label: "Not priced yet",
          priceCents: 1000,
          pricingStatus: "placeholder",
          piecesPerUnit: 12,
          netWeightGrams: null,
          stripePriceId: null,
        },
        {
          id: "not-counted",
          label: "Not counted yet",
          priceCents: 1000,
          pricingStatus: "confirmed",
          piecesPerUnit: null,
          netWeightGrams: null,
          stripePriceId: null,
        },
      ],
    },
    {
      sku: "HB-TEST-02",
      slug: "retired-tray",
      name: "Retired tray",
      active: false,
      leadTimeDays: 2,
      variants: [
        {
          id: "full-tray",
          label: "Full tray",
          priceCents: 4000,
          pricingStatus: "confirmed",
          piecesPerUnit: 24,
          netWeightGrams: null,
          stripePriceId: null,
        },
      ],
    },
  ];
}

/**
 * Two batches on a Sunday and a Monday, three on a Friday and a Saturday.
 * Tuesday is absent because Hakop has class, and the schedule module refuses
 * it in any case.
 */
export function testSchedule(overrides: Partial<BakeScheduleConfig> = {}): BakeScheduleConfig {
  return {
    timeZone: "America/Los_Angeles",
    availability: { batchesByWeekday: { 0: 2, 1: 2, 3: 2, 4: 2, 5: 3, 6: 3 } },
    cutoff: { hour: 20, minute: 0, daysBefore: 2 },
    piecesPerBatch: 24,
    horizonDays: 28,
    ...overrides,
  };
}

export function testFulfillment(overrides: Partial<FulfillmentConfig> = {}): FulfillmentConfig {
  return {
    pickup: { available: true, feeCents: 0, minimumOrderCents: 0 },
    delivery: {
      available: true,
      feeCents: 500,
      minimumOrderCents: 2000,
      zips: ["90630", "90620", "90623"],
    },
    shipping: { available: true, feeCents: 1200, minimumOrderCents: 0 },
    ...overrides,
  };
}

export function testSettings(overrides: Partial<ShopSettings> = {}): ShopSettings {
  return {
    siteUrl: "https://hakopsbakery.com",
    currency: "usd",
    timeZone: "America/Los_Angeles",
    contactEmail: "hello@hakopsbakery.com",
    adminEmail: "orders@hakopsbakery.com",
    foodTaxCode: "txcd_40060003",
    shippingTaxCode: "txcd_92010001",
    annualCapCents: 8_600_000,
    maxLinesPerOrder: 12,
    maxQtyPerLine: 20,
    sessionTtlMinutes: 30,
    ...overrides,
  };
}

export function testCompliance(overrides: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    registrationNumber: "CFO-TEST-0001",
    county: "Orange County",
    statement: HOME_KITCHEN_STATEMENT,
    acknowledgement: CONSENT_ACKNOWLEDGEMENT,
    disclosureVersion: DISCLOSURE_VERSION,
    complete: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* A durable store, for the tests that need one                        */
/* ------------------------------------------------------------------ */

/**
 * The in memory store, presented as durable.
 *
 * `create-checkout-session` refuses to run against storage that cannot
 * survive a cold start, which is correct in production and unhelpful in a
 * test. One test asserts the refusal directly, using the plain memory store.
 */
export function durableMemoryStore(): MemoryOrderStore {
  const store = createMemoryOrderStore();
  return { ...store, durable: true };
}

/* ------------------------------------------------------------------ */
/* Stripe, faked at the seam and real where it counts                  */
/* ------------------------------------------------------------------ */

export interface RecordedSession {
  readonly params: Stripe.Checkout.SessionCreateParams;
  readonly idempotencyKey: string;
  readonly result: CreatedSession;
}

export interface RecordedRefund {
  readonly params: Stripe.RefundCreateParams;
  readonly idempotencyKey: string;
}

export interface FakeStripe {
  readonly name: string;
  readonly sessions: RecordedSession[];
  readonly refunds: RecordedRefund[];
  failNextSessionWith(error: Error): void;
  failNextRefundWith(error: Error): void;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options: { idempotencyKey: string },
  ): Promise<CreatedSession>;
  createRefund(
    params: Stripe.RefundCreateParams,
    options: { idempotencyKey: string },
  ): Promise<CreatedRefund>;
  constructEvent(rawBody: string, signature: string, secret: string): Promise<Stripe.Event>;
}

export function fakeStripe(): FakeStripe {
  const sessions: RecordedSession[] = [];
  const refunds: RecordedRefund[] = [];
  const verifier = createVerifyOnlyGateway();
  let sessionError: Error | null = null;
  let refundError: Error | null = null;

  return {
    name: "fake",
    sessions,
    refunds,

    failNextSessionWith(error) {
      sessionError = error;
    },
    failNextRefundWith(error) {
      refundError = error;
    },

    async createCheckoutSession(params, options) {
      if (sessionError !== null) {
        const thrown = sessionError;
        sessionError = null;
        throw thrown;
      }
      /*
        Stripe returns the original object when a create is repeated with the
        same idempotency key. Copying that here is what makes the retry
        behaviour testable at all.
      */
      const seen = sessions.find((entry) => entry.idempotencyKey === options.idempotencyKey);
      if (seen !== undefined) return seen.result;

      const result: CreatedSession = {
        id: `cs_test_${sessions.length + 1}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_${sessions.length + 1}`,
        expiresAt: null,
      };
      sessions.push({ params, idempotencyKey: options.idempotencyKey, result });
      return result;
    },

    async createRefund(params, options) {
      if (refundError !== null) {
        const thrown = refundError;
        refundError = null;
        throw thrown;
      }
      const seen = refunds.find((entry) => entry.idempotencyKey === options.idempotencyKey);
      if (seen !== undefined) return { id: `re_test_dup`, status: "succeeded" };
      refunds.push({ params, idempotencyKey: options.idempotencyKey });
      return { id: `re_test_${refunds.length}`, status: "succeeded" };
    },

    /* The real verifier. Never faked. */
    constructEvent(rawBody, signature, secret) {
      return verifier.constructEvent(rawBody, signature, secret);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Everything else                                                     */
/* ------------------------------------------------------------------ */

export function harness(): {
  store: MemoryOrderStore;
  emailer: RecordingEmailer;
  logger: ReturnType<typeof memoryLogger>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  stripe: FakeStripe;
} {
  const logger = memoryLogger();
  return {
    store: durableMemoryStore(),
    emailer: createRecordingEmailer(),
    logger,
    rateLimiter: createRateLimiter(),
    stripe: fakeStripe(),
  };
}

/** A fixed clock. Friday 11 September 2026, 10am in Cypress. */
export const FRIDAY_MORNING = new Date("2026-09-11T17:00:00.000Z");

/** The first bake date that is open from FRIDAY_MORNING. A Sunday. */
export const OPEN_BAKE_DATE = "2026-09-13";
