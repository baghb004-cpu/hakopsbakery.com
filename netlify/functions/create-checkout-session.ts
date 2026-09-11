/**
 * Create a Stripe Checkout Session.
 *
 * This function and the webhook are the only places on this site where a bug
 * costs somebody money or breaks a legal condition of the business, so the
 * shape of it is deliberate: refuse early, refuse specifically, and never
 * take a number from the browser.
 *
 * WHAT THE BROWSER IS ALLOWED TO SEND
 *
 *   { lines: [{ sku, variantId, qty }],
 *     fulfillment: { mode, zip, bakeDate, slotId },
 *     consent: { accepted, version },
 *     email, requestId }
 *
 * That is the whole list. There is no price field, no total, no fee and no
 * discount, and the request schema strips unknown keys, so a crafted request
 * carrying `priceCents` loses it before any code reads the body. Prices come
 * out of the catalog on this side. Section 4 of docs/ARCHITECTURE.md.
 *
 * THE ORDER OF THE CHECKS
 *
 * Cheapest and most general first, so that the sentence a customer sees is
 * the most useful one available, and so that a request that was never going
 * to succeed does no work.
 *
 *   1. Is the shop open at all, and is it configured to take money safely?
 *   2. Does the request parse, and did the customer consent?
 *   3. Do the items exist, and what do they cost? (server side, always)
 *   4. Can we get them to this address? (the pre checkout California gate)
 *   5. Is the bake date real, open, and not past its cutoff?
 *   6. Is there capacity left, claimed atomically so two people cannot both
 *      take the last batch?
 *   7. Only then, Stripe.
 *
 * Step 6 is the one worth staring at. Checking capacity and then creating a
 * session is two steps, and two customers can both pass the check before
 * either claims anything. The claim happens in one operation inside the
 * store, before Stripe is called, and the hold is released if anything after
 * it fails.
 */

import type { Context } from "@netlify/functions";
import { z } from "zod";
import {
  addCalendarDays,
  buildBakeSchedule,
  compareCalendarDates,
  findBakeDate,
  isCalendarDate,
} from "@lib/bake-schedule";
import type { BakeScheduleConfig } from "@lib/bake-schedule";
import { resolveFulfillment } from "@lib/zones";
import type { FulfillmentConfig } from "@lib/zones";
import {
  clientIp,
  consoleLogger,
  describeError,
  internalError,
  methodNotAllowed,
  newReference,
  ok,
  readJsonBody,
  refuse,
  tooManyRequests,
} from "./_shared/http";
import type { Logger } from "./_shared/http";
import {
  bakeScheduleConfigFromEnv,
  complianceConfig,
  fulfillmentConfigFromEnv,
  shopSettings,
  storeIsOpen,
  stripeSecrets,
  env,
} from "./_shared/env";
import type { ComplianceConfig, ShopSettings } from "./_shared/env";
import { loadServerCatalog, maxLeadTimeDays, resolveLines } from "./_shared/catalog-server";
import type { ServerProduct } from "./_shared/catalog-server";
import { defaultOrderStore } from "./_shared/store";
import type { OrderStore } from "./_shared/store";
import { createStripeGateway } from "./_shared/stripe-gateway";
import type { Stripe, StripeGateway } from "./_shared/stripe-gateway";
import { defaultRateLimiter } from "./_shared/rate-limit";
import type { RateLimiter } from "./_shared/rate-limit";
import { normalizeEmail } from "./_shared/email";

export const config = { path: "/api/create-checkout-session" };

const RATE_RULE = { limit: 20, windowMs: 60_000 };

/* ------------------------------------------------------------------ */
/* What a browser may send                                             */
/* ------------------------------------------------------------------ */

/*
  z.object strips anything it does not name. That is not laziness, it is the
  gate: a request carrying priceCents, unitAmount, total, discount or
  currency arrives here and leaves without them, before a single line of
  pricing code runs. tests/checkout-session.test.ts sends exactly that and
  proves the charge is the catalog price.
*/
const requestSchema = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        variantId: z.string().min(1).max(64),
        qty: z.number(),
      }),
    )
    .min(1)
    .max(50),
  fulfillment: z.object({
    mode: z.enum(["pickup", "delivery", "shipping"]),
    zip: z.string().max(16).nullish(),
    bakeDate: z.string().max(32),
    slotId: z.string().max(64).nullish(),
  }),
  consent: z.object({
    accepted: z.boolean(),
    version: z.string().max(64).nullish(),
  }),
  email: z.string().max(254).nullish(),
  /**
   * Optional, and supplied by the browser once per checkout attempt. It makes
   * a retry of the same attempt idempotent: the same request produces the
   * same hold and the same Stripe idempotency key, so a double tap on a slow
   * connection cannot claim capacity twice or create two sessions.
   */
  requestId: z.string().min(8).max(100).nullish(),
});

export type CheckoutRequest = z.infer<typeof requestSchema>;

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface CheckoutDeps {
  now(): Date;
  catalog(): Promise<readonly ServerProduct[]>;
  readonly store: OrderStore;
  readonly stripe: StripeGateway;
  readonly fulfillment: FulfillmentConfig;
  readonly schedule: BakeScheduleConfig | null;
  readonly settings: ShopSettings;
  readonly compliance: ComplianceConfig;
  readonly storeOpen: boolean;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly successPath: string;
  readonly cancelPath: string;
}

/* ------------------------------------------------------------------ */
/* Deriving stable identifiers                                         */
/* ------------------------------------------------------------------ */

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One fingerprint for one checkout attempt.
 *
 * Everything that decides what is being bought goes in, sorted so that the
 * same cart in a different order produces the same fingerprint. The optional
 * requestId lets a customer who genuinely wants to order the same thing
 * again start a new attempt rather than being handed the old one.
 */
async function attemptFingerprint(request: CheckoutRequest): Promise<string> {
  const lines = [...request.lines]
    .map((line) => `${line.sku}:${line.variantId}:${line.qty}`)
    .sort()
    .join("|");
  const canonical = [
    lines,
    request.fulfillment.mode,
    request.fulfillment.zip ?? "",
    request.fulfillment.bakeDate,
    request.fulfillment.slotId ?? "",
    request.requestId ?? "",
  ].join("#");
  return await sha256Hex(canonical);
}

/** Short, readable, and printed on the bake list. Deterministic per attempt. */
function orderRefFrom(fingerprint: string): string {
  return `HB-${fingerprint.slice(0, 10).toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* The handler                                                         */
/* ------------------------------------------------------------------ */

export async function handleCreateCheckoutSession(
  req: Request,
  deps: CheckoutDeps,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const now = deps.now();
  const ip = clientIp(req);
  const limit = deps.rateLimiter.check(`checkout:${ip}`, RATE_RULE, now.getTime());
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  /* 1. Is the shop open, and is it safe to take money. --------------- */

  if (!deps.storeOpen) {
    /*
      The store cannot open without a registration number, because the
      footer would then be advertising a number that does not exist. The
      build gate protects the pages; a function answers whoever calls it, so
      it checks for itself.
    */
    return refuse(
      503,
      "store-closed",
      "The shop is not taking orders yet. Leave an email address and you " +
        "will hear the day it opens.",
    );
  }

  if (!deps.store.durable) {
    /*
      Capacity cannot be protected by storage that does not survive a cold
      start, and two function instances holding separate copies will both
      sell the last batch. Refusing is the only honest answer. This is a
      deployment problem, not a customer problem, so it is logged as an
      error and the customer is told plainly that nothing was charged.
    */
    deps.logger.error("checkout.storage-not-durable", { store: deps.store.name });
    return refuse(
      503,
      "storage-not-configured",
      "Ordering is briefly unavailable. Nothing was charged. Try again shortly.",
    );
  }

  /* 2. Does the request parse, and did the customer consent. --------- */

  const body = await readJsonBody(req, 16 * 1024);
  if (!body.ok) return body.response;

  const parsed = requestSchema.safeParse(body.value);
  if (!parsed.success) {
    return refuse(400, "bad-request", "That order could not be read. Reload the page and try again.");
  }
  const request = parsed.data;

  if (request.lines.length > deps.settings.maxLinesPerOrder) {
    return refuse(
      400,
      "too-many-lines",
      `An order can hold up to ${deps.settings.maxLinesPerOrder} different items.`,
    );
  }

  if (request.consent.accepted !== true) {
    return refuse(
      400,
      "consent-required",
      "The home kitchen statement has to be acknowledged before an order can be placed.",
    );
  }
  if (
    request.consent.version !== null &&
    request.consent.version !== undefined &&
    request.consent.version !== deps.compliance.disclosureVersion
  ) {
    /*
      A stale page is showing wording that is no longer current. Recording
      consent to the old wording and charging against the new one would make
      the evidence worthless, so the page is asked to reload instead.
    */
    return refuse(
      409,
      "consent-version-stale",
      "This page is out of date. Reload it and place the order again.",
      { currentVersion: deps.compliance.disclosureVersion },
    );
  }

  /* 3. What is being bought, and what does it cost. ------------------ */

  let catalog: readonly ServerProduct[];
  try {
    catalog = await deps.catalog();
  } catch (cause) {
    const reference = newReference();
    deps.logger.error("checkout.catalog-unreadable", { reference, ...describeError(cause) });
    return internalError(reference);
  }

  const resolved = resolveLines(catalog, request.lines, {
    maxQtyPerLine: deps.settings.maxQtyPerLine,
    defaultTaxCode: deps.settings.foodTaxCode,
  });
  if (!resolved.ok) {
    /*
      placeholder-price and pieces-not-counted are configuration faults, not
      customer faults, and they must be loud in the log even though the
      customer sees a calm sentence.
    */
    if (resolved.code === "placeholder-price" || resolved.code === "pieces-not-counted") {
      deps.logger.error("checkout.catalog-not-ready", {
        code: resolved.code,
        sku: resolved.sku,
        variantId: resolved.variantId,
      });
    }
    return refuse(409, resolved.code, resolved.message, {
      sku: resolved.sku,
      variantId: resolved.variantId,
    });
  }
  if (resolved.subtotalCents <= 0) {
    return refuse(400, "empty-order", "There is nothing in this order.");
  }

  /* 4. Can we get it to them. The pre checkout California gate. ------ */

  const fulfillment = resolveFulfillment(
    request.fulfillment.mode,
    request.fulfillment.zip ?? null,
    deps.fulfillment,
    resolved.subtotalCents,
  );
  if (!fulfillment.ok) {
    return refuse(409, fulfillment.reason, fulfillment.message, {
      mode: fulfillment.mode,
      shortfallCents: fulfillment.shortfallCents,
    });
  }

  /* 5. Is the bake date real and still open. ------------------------- */

  if (deps.schedule === null) {
    deps.logger.error("checkout.schedule-not-configured", {});
    return refuse(
      503,
      "availability-not-configured",
      "Bake dates are not open yet. Nothing was charged.",
    );
  }
  if (!isCalendarDate(request.fulfillment.bakeDate)) {
    return refuse(400, "bake-date-invalid", "Choose a bake date.");
  }

  const committed = await deps.store.committedOrders(now.getTime());
  const schedule = buildBakeSchedule({ config: deps.schedule, orders: committed, now });
  const bakeDate = findBakeDate(schedule, request.fulfillment.bakeDate);

  if (bakeDate === null) {
    return refuse(409, "bake-date-unavailable", "That is not a bake day. Choose another date.");
  }
  if (!bakeDate.selectable) {
    /*
      status carries which of the three it is: blackout, past-cutoff or
      sold-out. The picker shows the right sentence from that rather than
      guessing, and a customer never meets a sold out date for the first
      time at payment.
    */
    const messages: Record<string, string> = {
      blackout: "Hakop is not baking that day. Choose another date.",
      "past-cutoff": "Ordering has closed for that date. Choose a later one.",
      "sold-out": "That bake date is full. Choose another date.",
    };
    return refuse(409, `bake-date-${bakeDate.status}`, messages[bakeDate.status] ?? "That date is not available.", {
      status: bakeDate.status,
      cutoffAt: bakeDate.cutoffAt,
    });
  }

  /*
    Lead time is a separate constraint from the cutoff and the stricter of
    the two wins. The cutoff is a shop rule about when the list is drawn up.
    Lead time is a property of the pastry.
  */
  const leadDays = maxLeadTimeDays(resolved.lines);
  const earliest = addCalendarDays(schedule.today, leadDays);
  if (compareCalendarDates(bakeDate.date, earliest) < 0) {
    return refuse(409, "bake-date-too-soon", `That order needs ${leadDays} days. Choose a later date.`, {
      earliestDate: earliest,
    });
  }

  /* 6. Claim the capacity, atomically, before Stripe. ---------------- */

  const fingerprint = await attemptFingerprint(request);
  const orderRef = orderRefFrom(fingerprint);
  const holdId = `hold_${fingerprint.slice(0, 32)}`;
  const expiresAtMs = now.getTime() + deps.settings.sessionTtlMinutes * 60_000;

  const reservation = await deps.store.reserve({
    holdId,
    bakeDate: bakeDate.date,
    pieces: resolved.piecesTotal,
    capacityPieces: bakeDate.capacity.capacityPieces,
    orderRef,
    expiresAt: expiresAtMs,
    now: now.getTime(),
  });

  if (!reservation.ok) {
    return refuse(409, "bake-date-sold-out", "That bake date filled up while you were ordering. Choose another date.", {
      date: bakeDate.date,
      remainingPieces: reservation.remainingPieces,
    });
  }

  /* 7. Stripe. ------------------------------------------------------- */

  const params = buildSessionParams({
    request,
    resolved,
    fulfillment,
    bakeDate: bakeDate.date,
    orderRef,
    holdId,
    settings: deps.settings,
    compliance: deps.compliance,
    expiresAtMs,
    successPath: deps.successPath,
    cancelPath: deps.cancelPath,
    consentAt: now.toISOString(),
  });

  try {
    const session = await deps.stripe.createCheckoutSession(params, {
      /*
        Derived from the attempt, not from a random value, so that a retry of
        the same attempt returns the session that already exists instead of
        creating a second one against the same held capacity.
      */
      idempotencyKey: `checkout:${fingerprint}`,
    });

    if (session.url === null) {
      /*
        A hosted session always carries a URL. Without one the customer has
        nowhere to pay, so the session is useless: give the capacity back
        rather than holding a bake day for an order that cannot complete.
      */
      await deps.store.releaseHold(holdId);
      const reference = newReference();
      deps.logger.error("checkout.session-without-url", { reference, orderRef, sessionId: session.id });
      return internalError(reference, "Checkout could not be opened. Nothing was charged.");
    }

    /*
      The site's own record of consent, written before the customer reaches
      Stripe. This is the primary evidence. Stripe's consent_collection is a
      second layer and is recorded again in the webhook, but it belongs to
      Stripe's terms of service flow and it is not the cottage food
      disclosure, so it can never be the only copy.
    */
    await deps.store.recordConsent({
      orderRef,
      sessionId: session.id,
      statement: deps.compliance.statement,
      acknowledgement: deps.compliance.acknowledgement,
      version: deps.compliance.disclosureVersion,
      county: deps.compliance.county,
      registrationNumber: deps.compliance.registrationNumber,
      acceptedAt: now.toISOString(),
      source: "checkout",
      ip,
      userAgent: req.headers.get("user-agent"),
    });

    deps.logger.info("checkout.session-created", {
      orderRef,
      sessionId: session.id,
      bakeDate: bakeDate.date,
      mode: fulfillment.mode,
      piecesTotal: resolved.piecesTotal,
      subtotalCents: resolved.subtotalCents,
      reusedHold: reservation.reused,
    });

    return ok({
      sessionId: session.id,
      url: session.url,
      orderRef,
      bakeDate: bakeDate.date,
      expiresAt: new Date(expiresAtMs).toISOString(),
      /*
        Echoed so the cart can show the customer the same numbers the server
        used, and so a mismatch with what the browser calculated is visible
        rather than silent.
      */
      subtotalCents: resolved.subtotalCents,
      fulfillmentFeeCents: fulfillment.feeCents,
    });
  } catch (cause) {
    /*
      Nothing was charged: a session that failed to create cannot have taken
      money. Give the capacity back rather than leaving it held for half an
      hour by an order that does not exist.
    */
    await deps.store.releaseHold(holdId);

    const reference = newReference();
    deps.logger.error("checkout.stripe-failed", { reference, orderRef, ...describeError(cause) });
    /*
      The Stripe error never reaches the browser. It can carry an account
      id, a key prefix, or the shape of an internal object.
    */
    return internalError(reference, "Checkout could not be started. Nothing was charged. Try again in a moment.");
  }
}

/* ------------------------------------------------------------------ */
/* Building the session                                                */
/* ------------------------------------------------------------------ */

interface BuildInput {
  readonly request: CheckoutRequest;
  readonly resolved: Extract<ReturnType<typeof resolveLines>, { ok: true }>;
  readonly fulfillment: { readonly mode: string; readonly zip: string | null; readonly feeCents: number };
  readonly bakeDate: string;
  readonly orderRef: string;
  readonly holdId: string;
  readonly settings: ShopSettings;
  readonly compliance: ComplianceConfig;
  readonly expiresAtMs: number;
  readonly successPath: string;
  readonly cancelPath: string;
  readonly consentAt: string;
}

/** Stripe metadata values are capped at 500 characters. Keep inside it. */
function clip(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

export function buildSessionParams(input: BuildInput): Stripe.Checkout.SessionCreateParams {
  const { settings, compliance, resolved, fulfillment } = input;
  const currency = settings.currency;
  const needsAddress = fulfillment.mode === "delivery" || fulfillment.mode === "shipping";

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = resolved.lines.map((line) => ({
    quantity: line.qty,
    /*
      Quantities are fixed once the session exists. The capacity hold was
      taken for exactly this many pieces, and letting a customer raise the
      quantity inside Stripe Checkout would sell a batch that was never
      reserved.
    */
    adjustable_quantity: { enabled: false },
    ...(line.stripePriceId === null
      ? {
          price_data: {
            currency,
            unit_amount: line.unitPriceCents,
            /*
              Exclusive: the price on the label is the price of the food, and
              California sales tax, where it applies at all, is added on top
              rather than buried in the number.
            */
            tax_behavior: "exclusive" as const,
            product_data: {
              name: `${line.productName}, ${line.variantLabel}`,
              metadata: { sku: line.sku, variantId: line.variantId },
              /*
                The Stripe Tax category for this line. Food and prepared food
                are taxed differently in California and the code decides
                which rule applies. See the note in _shared/env.ts: it is
                configuration, and it needs confirming before opening.
              */
              tax_code: line.taxCode,
            },
          },
        }
      : {
          /*
            Once a variant carries a Stripe Price id, that object is the
            price and the tax category sits on the Stripe Product behind it.
            Either way the browser never supplied the number.
          */
          price: line.stripePriceId,
        }),
  }));

  const summary = resolved.lines
    .map((line) => `${line.sku}:${line.variantId}:${line.qty}`)
    .join("|");

  const metadata: Record<string, string> = {
    orderRef: input.orderRef,
    holdId: input.holdId,
    bakeDate: input.bakeDate,
    fulfillmentMode: fulfillment.mode,
    fulfillmentZip: fulfillment.zip ?? "",
    fulfillmentFeeCents: String(fulfillment.feeCents),
    subtotalCents: String(resolved.subtotalCents),
    piecesTotal: String(resolved.piecesTotal),
    lines: clip(summary),
    /*
      The consent evidence travels with the payment as well as sitting in our
      own store, so that a Stripe dashboard view of a disputed charge shows
      which wording the customer agreed to without anybody opening a
      database.
    */
    consentVersion: compliance.disclosureVersion,
    consentAt: input.consentAt,
    cfoCounty: compliance.county ?? "",
    cfoRegistration: compliance.registrationNumber ?? "",
  };

  const shippingMessage =
    "Hakop's Bakery is a cottage food operation and can only sell inside " +
    "California. Enter a California address, or go back and choose pickup.";

  return {
    mode: "payment",
    submit_type: "pay",
    line_items: lineItems,
    currency,
    client_reference_id: input.orderRef,
    metadata,

    /*
      Stripe Tax works out California sales tax from the address the customer
      ends up entering, per line, using the tax codes above. It needs an
      origin address set in the Stripe Tax settings, which is part of the
      launch runbook rather than something a function can assert.
    */
    automatic_tax: { enabled: true },

    /*
      Required even for pickup: Stripe Tax needs an address to work from, and
      for a pickup order the billing address is the only one there is.
    */
    billing_address_collection: "required",

    /*
      The second of the three places the California gate is enforced.
      Countries are locked to the United States, and the custom text says in
      words what the country list cannot: that inside the United States, only
      California addresses can be served. A customer can still type a Nevada
      address here, which is exactly why the webhook checks again.
    */
    ...(needsAddress
      ? {
          shipping_address_collection: { allowed_countries: ["US" as const] },
          ...(fulfillment.mode === "delivery" ? { phone_number_collection: { enabled: true } } : {}),
        }
      : {}),

    custom_text: {
      ...(needsAddress ? { shipping_address: { message: shippingMessage } } : {}),
      submit: {
        message: clip(
          `${compliance.statement} Baked for ${input.bakeDate}.`,
        ),
      },
      terms_of_service_acceptance: {
        message: clip(`${compliance.statement} ${compliance.acknowledgement}`),
      },
    },

    /*
      A second layer only. The site records its own consent to the cottage
      food disclosure before the customer ever reaches Stripe, and that
      record is the evidence. This ticks Stripe's terms of service box, which
      needs a terms of service URL configured in the Stripe dashboard.
    */
    consent_collection: { terms_of_service: "required" },

    /*
      The hold behind this session expires at the same moment. A session that
      outlived its hold would let somebody pay for capacity that has been
      given away.
    */
    expires_at: Math.floor(input.expiresAtMs / 1000),

    ...(input.request.email !== null && input.request.email !== undefined && normalizeEmail(input.request.email) !== null
      ? { customer_email: normalizeEmail(input.request.email) as string }
      : {}),

    ...(fulfillment.feeCents > 0
      ? {
          shipping_options: [
            {
              shipping_rate_data: {
                type: "fixed_amount" as const,
                fixed_amount: { amount: fulfillment.feeCents, currency },
                display_name:
                  fulfillment.mode === "delivery" ? "Local delivery" : "Shipping inside California",
                tax_behavior: "exclusive" as const,
                tax_code: settings.shippingTaxCode,
              },
            },
          ],
        }
      : {}),

    payment_intent_data: {
      description: `${input.orderRef}, baked ${input.bakeDate}`,
      /*
        Repeated on the PaymentIntent so that a refund, a dispute or a
        payout line can be traced back to an order without a second lookup.
      */
      metadata,
    },

    success_url: `${settings.siteUrl}${input.successPath}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${settings.siteUrl}${input.cancelPath}`,
  };
}

/* ------------------------------------------------------------------ */
/* The real dependencies                                               */
/* ------------------------------------------------------------------ */

export default async (req: Request, _context: Context): Promise<Response> => {
  const settings = shopSettings();
  const secrets = stripeSecrets();

  if (secrets.secretKey === null) {
    consoleLogger.error("checkout.stripe-key-missing", {});
    return refuse(
      503,
      "payments-not-configured",
      "Ordering is briefly unavailable. Nothing was charged.",
    );
  }

  return handleCreateCheckoutSession(req, {
    now: () => new Date(),
    catalog: loadServerCatalog,
    store: defaultOrderStore(),
    stripe: createStripeGateway(secrets.secretKey),
    fulfillment: fulfillmentConfigFromEnv(),
    schedule: bakeScheduleConfigFromEnv(),
    settings,
    compliance: complianceConfig(),
    storeOpen: storeIsOpen(),
    rateLimiter: defaultRateLimiter(),
    logger: consoleLogger,
    successPath: env("CHECKOUT_SUCCESS_PATH") ?? "/order/confirmed/",
    cancelPath: env("CHECKOUT_CANCEL_PATH") ?? "/cart/",
  });
};
