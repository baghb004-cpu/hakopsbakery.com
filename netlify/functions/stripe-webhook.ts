/**
 * The Stripe webhook.
 *
 * Three things have to be right here, and all three are things that are
 * commonly got wrong.
 *
 * SIGNATURE VERIFICATION OVER THE RAW BODY
 *
 * The signature is computed over the exact bytes Stripe sent. Any framework
 * that parses JSON for you, and any code that does `JSON.stringify(await
 * req.json())` before verifying, changes those bytes: key order, whitespace
 * and number formatting are all free to differ, and verification then fails
 * for real deliveries and, worse, invites somebody to "fix" it by skipping
 * the check. This function reads `await req.text()` as its first act and
 * passes that string, untouched, to the verifier. Nothing parses the body
 * before it is verified.
 *
 * IDEMPOTENCY
 *
 * Stripe retries. A delivery that times out, or that we answer with a 500,
 * comes back with the same event id, and the same event id must not produce
 * a second order or a second refund. Event ids are claimed in the store
 * before any work happens, and released again if the work fails, so a retry
 * of a half finished event is treated as new work while a retry of a
 * finished one is a no op.
 *
 * THE FINAL ADDRESS CHECK
 *
 * See the block comment further down, above `californiaGate`. It is the step
 * the brief singles out as the one that gets skipped.
 */

import type { Context } from "@netlify/functions";
import { calendarYearIn } from "@lib/bake-schedule";
import { isCaliforniaZip } from "@lib/california";
import { isInDeliveryArea } from "@lib/zones";
import type { FulfillmentConfig, FulfillmentMode } from "@lib/zones";
import { consoleLogger, describeError, jsonResponse, methodNotAllowed } from "./_shared/http";
import type { Logger } from "./_shared/http";
import { complianceConfig, fulfillmentConfigFromEnv, shopSettings, stripeSecrets } from "./_shared/env";
import type { ComplianceConfig, ShopSettings } from "./_shared/env";
import { defaultOrderStore } from "./_shared/store";
import type { OrderLineRecord, OrderStore } from "./_shared/store";
import { createStripeGateway, createVerifyOnlyGateway } from "./_shared/stripe-gateway";
import type { Stripe, StripeGateway } from "./_shared/stripe-gateway";
import { defaultEmailer } from "./_shared/email";
import type { Emailer } from "./_shared/email";
import { capContributionFromSession, capMeter } from "./_shared/cap";

export const config = { path: "/api/stripe-webhook" };

/* ------------------------------------------------------------------ */
/* The shape a completed session arrives in                            */
/* ------------------------------------------------------------------ */

/*
  Written structurally rather than against the SDK's Session type on purpose.

  The version of a webhook payload is set on the endpoint in the Stripe
  dashboard, not by the SDK, so this code can be handed an older shape than
  the one the installed types describe. The clearest example is the final
  shipping address: current versions carry it at
  `collected_information.shipping_details`, older ones at `shipping_details`.
  Reading only the current location against an older endpoint would silently
  find nothing, and finding nothing is precisely how the California gate ends
  up being skipped without anybody noticing.
*/
interface AddressLike {
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postal_code?: string | null;
  readonly country?: string | null;
}

interface CompletedSession {
  readonly id: string;
  readonly metadata?: Record<string, string> | null;
  readonly payment_status?: string | null;
  readonly payment_intent?: string | { id?: string } | null;
  readonly customer_details?: {
    readonly email?: string | null;
    readonly name?: string | null;
    readonly address?: AddressLike | null;
  } | null;
  readonly collected_information?: {
    readonly shipping_details?: { readonly address?: AddressLike | null } | null;
  } | null;
  /** Older API versions put the final shipping address here. */
  readonly shipping_details?: { readonly address?: AddressLike | null } | null;
  readonly consent?: { readonly terms_of_service?: string | null } | null;
  readonly amount_total?: number | null;
}

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface WebhookDeps {
  now(): Date;
  readonly store: OrderStore;
  readonly stripe: Pick<StripeGateway, "constructEvent" | "createRefund">;
  readonly emailer: Emailer;
  readonly fulfillment: FulfillmentConfig;
  readonly settings: ShopSettings;
  readonly compliance: ComplianceConfig;
  readonly webhookSecret: string | null;
  readonly logger: Logger;
}

/* ------------------------------------------------------------------ */
/* Reading the final address                                           */
/* ------------------------------------------------------------------ */

function shippingAddressOf(session: CompletedSession): AddressLike | null {
  return (
    session.collected_information?.shipping_details?.address ??
    session.shipping_details?.address ??
    null
  );
}

function billingAddressOf(session: CompletedSession): AddressLike | null {
  return session.customer_details?.address ?? null;
}

/** "CA", "ca" and "California" all mean the same thing. Nothing else does. */
function isCaliforniaState(state: string | null | undefined): boolean {
  if (typeof state !== "string") return false;
  const value = state.trim().toLowerCase();
  return value === "ca" || value === "california";
}

export type GateFailure =
  | "address-missing"
  | "country-not-us"
  | "state-not-california"
  | "zip-not-california"
  | "zip-outside-delivery-area";

export type GateResult =
  | { readonly ok: true; readonly zip: string | null; readonly checked: boolean }
  | { readonly ok: false; readonly code: GateFailure; readonly detail: string };

/**
 * BRIEF SECTION 8, STEP 5. THIS IS THE STEP THAT GETS SKIPPED.
 * DO NOT REMOVE IT, DO NOT MAKE IT CONDITIONAL, DO NOT TRUST THE PRE
 * CHECKOUT CHECK THAT ALREADY PASSED.
 *
 * The customer entered a ZIP in the cart and it was in California, and then
 * they went to Stripe Checkout and typed a different address. That is not an
 * attack, it is an ordinary thing people do: they ship a gift, they use a
 * work address, they correct an autofill. The pre checkout gate cannot see
 * any of it, because it ran before the address existed.
 *
 * A Class A cottage food operation may only sell inside California. An order
 * going anywhere else is not a customer service problem to smooth over, it
 * is the business operating outside the terms of its registration. So the
 * final address, the one on the completed session, is read here and checked
 * again, and if it is outside California the order is refunded in full, the
 * customer is emailed an explanation, and it is flagged for Hakop.
 *
 * It fails closed. A delivery or shipping order with no address at all is
 * refused exactly like an out of state one, because an address that cannot
 * be read cannot be confirmed to be in California, and "we could not tell"
 * must never resolve to "fulfil it".
 *
 * Pickup is the one exception, and it is deliberate rather than an oversight.
 * The sale happens at the door in Cypress, so the address on the card tells
 * us nothing about where the transaction takes place. Somebody visiting from
 * Nevada may drive to Cypress and collect a tray, and refunding them would
 * be wrong.
 */
export function californiaGate(
  session: CompletedSession,
  mode: FulfillmentMode | null,
  fulfillment: FulfillmentConfig,
): GateResult {
  const shipping = shippingAddressOf(session);

  if (mode === "pickup") {
    // Collected at the door in Cypress. See the note above.
    return { ok: true, zip: null, checked: false };
  }

  /*
    An unknown mode means a session this site did not create, or one whose
    metadata was lost. If it carries a shipping address, the address is
    checked exactly as a shipping order would be. If it does not, there is
    nothing to check and the flag raised by the caller is what gets a human
    to look at it.
  */
  const address = shipping ?? (mode === null ? null : billingAddressOf(session));

  if (address === null) {
    if (mode === null) return { ok: true, zip: null, checked: false };
    return {
      ok: false,
      code: "address-missing",
      detail: "The completed session carried no address to check.",
    };
  }

  const country = typeof address.country === "string" ? address.country.trim().toUpperCase() : "";
  if (country !== "US") {
    return { ok: false, code: "country-not-us", detail: `country=${country || "none"}` };
  }

  if (!isCaliforniaState(address.state)) {
    return {
      ok: false,
      code: "state-not-california",
      detail: `state=${String(address.state ?? "none")}`,
    };
  }

  const zip = isCaliforniaZip(address.postal_code);
  if (!zip.ok) {
    /*
      The state field and the ZIP have to agree. A card billed to "CA" with a
      Nevada ZIP is either a mistake or an attempt, and either way it is not
      an address this operation can serve.
    */
    return {
      ok: false,
      code: "zip-not-california",
      detail: `zip=${String(address.postal_code ?? "none")} reason=${zip.reason}`,
    };
  }

  if (mode === "delivery" && !isInDeliveryArea(zip.zip, fulfillment.delivery.zips)) {
    return {
      ok: false,
      code: "zip-outside-delivery-area",
      detail: `zip=${zip.zip} is in California but outside the delivery run.`,
    };
  }

  return { ok: true, zip: zip.zip, checked: true };
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

const MODES: readonly FulfillmentMode[] = ["pickup", "delivery", "shipping"];

function modeFrom(metadata: Record<string, string> | null | undefined): FulfillmentMode | null {
  const raw = metadata?.["fulfillmentMode"];
  return MODES.find((mode) => mode === raw) ?? null;
}

function intFrom(metadata: Record<string, string> | null | undefined, key: string): number {
  const parsed = Number.parseInt(metadata?.[key] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "HB-GATA-01:full-tray:2|..." back into rows. Best effort, never throws. */
function linesFrom(metadata: Record<string, string> | null | undefined): OrderLineRecord[] {
  const raw = metadata?.["lines"];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const out: OrderLineRecord[] = [];
  for (const part of raw.split("|")) {
    const [sku, variantId, qty] = part.split(":");
    if (sku === undefined || variantId === undefined || qty === undefined) continue;
    const quantity = Number.parseInt(qty, 10);
    if (!Number.isFinite(quantity)) continue;
    out.push({ sku, variantId, qty: quantity, unitPriceCents: 0, piecesPerUnit: 0 });
  }
  return out;
}

function paymentIntentIdOf(session: CompletedSession): string | null {
  const value = session.payment_intent;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

/* ------------------------------------------------------------------ */
/* The handler                                                         */
/* ------------------------------------------------------------------ */

export async function handleStripeWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  /*
    FIRST. Before anything else touches this request.

    The raw text is what the signature covers. Read it once, keep the string,
    and hand that exact string to the verifier. Nothing between here and
    constructEvent is allowed to parse, normalise or re-serialise it.
  */
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (cause) {
    deps.logger.error("webhook.body-unreadable", describeError(cause));
    return jsonResponse(400, { error: "unreadable-body" });
  }

  const signature = req.headers.get("stripe-signature");
  if (signature === null || signature.trim() === "") {
    deps.logger.warn("webhook.signature-missing", {});
    return jsonResponse(400, { error: "signature-missing" });
  }

  if (deps.webhookSecret === null) {
    /*
      Without the signing secret nothing can be verified, and an unverified
      body is an anonymous stranger asking us to ship food. A 500 tells
      Stripe to retry, which is what we want once the secret is set.
    */
    deps.logger.error("webhook.secret-missing", {});
    return jsonResponse(500, { error: "webhook-not-configured" });
  }

  let event: Stripe.Event;
  try {
    event = await deps.stripe.constructEvent(rawBody, signature, deps.webhookSecret);
  } catch (cause) {
    /*
      400, always, and nothing about why. A forged request learns only that
      it was rejected. This also catches a replayed delivery whose timestamp
      is outside Stripe's tolerance.
    */
    deps.logger.warn("webhook.signature-invalid", describeError(cause));
    return jsonResponse(400, { error: "signature-invalid" });
  }

  const now = deps.now();
  const claim = await deps.store.beginEvent(event.id, now.getTime());
  if (claim === "done") {
    deps.logger.info("webhook.duplicate", { eventId: event.id, type: event.type, claim });
    return jsonResponse(200, { received: true, duplicate: true });
  }
  if (claim === "in-flight") {
    /*
      Another delivery of this same event is part way through it. Answering
      200 would tell Stripe the event is handled and stop the retries, and if
      that other attempt never finishes, the order it was recording is lost
      with nothing to bring it back. A non 2xx leaves the delivery unhandled,
      so Stripe returns with it: by then the claim is either done, which
      answers 200 above, or old enough for the store to hand over.
    */
    deps.logger.warn("webhook.claim-in-flight", { eventId: event.id, type: event.type });
    return jsonResponse(409, { error: "event-in-flight" });
  }

  try {
    await route(event, deps, now);
    await deps.store.completeEvent(event.id);
    return jsonResponse(200, { received: true });
  } catch (cause) {
    /*
      Give the event id back so Stripe's retry is treated as new work. An
      event left marked as handled after a failure is an order that silently
      never happens.
    */
    await deps.store.failEvent(event.id);
    deps.logger.error("webhook.handler-failed", {
      eventId: event.id,
      type: event.type,
      ...describeError(cause),
    });
    return jsonResponse(500, { error: "handler-failed" });
  }
}

async function route(event: Stripe.Event, deps: WebhookDeps, now: Date): Promise<void> {
  switch (event.type) {
    /*
      Both, and for the same reason. A card pays inside the session and
      `completed` already carries payment_status paid. A bank debit completes
      the session while the money is still moving, so `completed` arrives
      unpaid and is set aside below, and the money landing is announced later
      as `async_payment_succeeded` carrying the same session. Handling only
      the first would take payment for an order that is never recorded, never
      put through the California gate and never counted against the annual
      ceiling. The failure of the same flow was already handled, so the
      success has to be. onSessionCompleted is idempotent per session, so the
      ordinary card case, where both could in principle arrive, records one
      order.
    */
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await onSessionCompleted(event.data.object as unknown as CompletedSession, deps, now);
      return;

    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      /*
        Nobody is paying for this one. Hand the capacity back now rather than
        waiting for the hold to time out, so the date reopens in the picker
        while somebody might still want it.
      */
      const session = event.data.object as unknown as CompletedSession;
      const holdId = session.metadata?.["holdId"];
      if (typeof holdId === "string" && holdId !== "") {
        await deps.store.releaseHold(holdId);
        deps.logger.info("webhook.hold-released", { holdId, reason: event.type });
      }
      return;
    }

    default:
      deps.logger.info("webhook.ignored", { type: event.type });
  }
}

/* ------------------------------------------------------------------ */
/* checkout.session.completed                                          */
/* ------------------------------------------------------------------ */

async function onSessionCompleted(
  session: CompletedSession,
  deps: WebhookDeps,
  now: Date,
): Promise<void> {
  const metadata = session.metadata ?? null;
  const orderRef = metadata?.["orderRef"] ?? session.id;
  const holdId = metadata?.["holdId"] ?? null;
  const bakeDate = metadata?.["bakeDate"] ?? "";
  const mode = modeFrom(metadata);

  /*
    A second layer of idempotency, on the session rather than the event.
    Stripe can deliver more than one event type for the same completed
    session (completed, then async_payment_succeeded), and neither may create
    a second order.
  */
  const already = await deps.store.findOrderBySession(session.id);
  if (already !== null) {
    deps.logger.info("webhook.session-already-recorded", { sessionId: session.id, orderRef });
    return;
  }

  /*
    Bank debits and other delayed methods complete the session before the
    money arrives. Nothing is fulfilled and no capacity is confirmed until
    it does, and the hold stays in place meanwhile.
  */
  const paymentStatus = session.payment_status ?? "paid";
  if (paymentStatus === "unpaid") {
    deps.logger.info("webhook.payment-pending", { sessionId: session.id, orderRef });
    return;
  }

  if (metadata === null || mode === null) {
    await deps.store.flag({
      code: "session-without-metadata",
      orderRef,
      sessionId: session.id,
      detail: "A completed session arrived without the metadata this site attaches.",
      createdAt: now.toISOString(),
    });
    deps.logger.warn("webhook.metadata-missing", { sessionId: session.id });
  }

  /* THE FINAL ADDRESS CHECK. Brief section 8 step 5. ----------------- */

  const gate = californiaGate(session, mode, deps.fulfillment);

  if (!gate.ok) {
    await refundOutOfState(session, deps, now, { orderRef, holdId, bakeDate, mode, gate });
    return;
  }

  /* The order stands. ------------------------------------------------ */

  if (holdId !== null && holdId !== "") {
    const held = await deps.store.confirmHold(holdId, orderRef, now.getTime());
    if (!held) {
      /*
        Paid, but the hold behind it is gone: it expired, or something
        released it while the customer was still on the Stripe page. The
        order is real and stands, and it is recorded below, but it is holding
        no capacity, so the bake day it belongs to now reads as emptier than
        it is and can be sold twice. Nothing here can put the capacity back
        without risking a date that is genuinely full, so it goes to Hakop.
      */
      deps.logger.error("webhook.hold-missing", { orderRef, sessionId: session.id, holdId, bakeDate });
      await deps.store.flag({
        code: "capacity-not-held",
        orderRef,
        sessionId: session.id,
        detail:
          `This order is paid but its capacity hold ${holdId} no longer exists, so ` +
          `${bakeDate || "its bake date"} is not counting it. Check that day is not oversold.`,
        createdAt: now.toISOString(),
        context: { holdId, bakeDate, piecesTotal: intFrom(metadata, "piecesTotal") },
      });
    }
  }

  const contribution = capContributionFromSession(session);
  const customerEmail = session.customer_details?.email ?? null;

  await deps.store.recordOrder({
    orderRef,
    sessionId: session.id,
    paymentIntentId: paymentIntentIdOf(session),
    status: "paid",
    bakeDate,
    mode: mode ?? "unknown",
    zip: gate.zip,
    lines: linesFrom(metadata),
    piecesTotal: intFrom(metadata, "piecesTotal"),
    amountTotalCents: typeof session.amount_total === "number" ? session.amount_total : 0,
    amountTaxCents: contribution.amountTaxCents,
    capContributionCents: contribution.capContributionCents,
    customerEmail,
    createdAt: now.toISOString(),
  });

  /*
    The consent evidence, bound to the order now that there is one. The
    primary record was written when the session was created; this one adds
    the order id and what Stripe collected as its own second layer.
  */
  await deps.store.recordConsent({
    orderRef,
    sessionId: session.id,
    statement: deps.compliance.statement,
    acknowledgement: deps.compliance.acknowledgement,
    version: metadata?.["consentVersion"] ?? deps.compliance.disclosureVersion,
    county: metadata?.["cfoCounty"] ?? deps.compliance.county,
    registrationNumber: metadata?.["cfoRegistration"] ?? deps.compliance.registrationNumber,
    acceptedAt: metadata?.["consentAt"] ?? now.toISOString(),
    source: "webhook",
    ip: null,
    userAgent: null,
    stripeTermsOfService: session.consent?.terms_of_service ?? null,
  });

  if (!contribution.consistent) {
    /*
      Stripe's total and Stripe's own breakdown of that total disagree. That
      should be impossible, so it is worth a human rather than a silent
      choice between two numbers.
    */
    await deps.store.flag({
      code: "amounts-inconsistent",
      orderRef,
      sessionId: session.id,
      detail: `total minus tax is ${contribution.capContributionCents}, breakdown is ${contribution.crossCheckCents}`,
      createdAt: now.toISOString(),
    });
  }

  await checkAnnualCap(deps, now, orderRef, session.id);

  if (customerEmail !== null) {
    await deps.emailer.send({
      to: customerEmail,
      subject: `Order ${orderRef} is in the book`,
      tag: "order-confirmed",
      text:
        `Thank you. Order ${orderRef} is on the list for ${bakeDate || "the date you chose"}.\n\n` +
        `${deps.compliance.statement}\n\n` +
        `Any questions, reply to this message or write to ${deps.settings.contactEmail}.`,
      replyTo: deps.settings.contactEmail,
    });
  }

  await deps.emailer.send({
    to: deps.settings.adminEmail,
    subject: `New order ${orderRef}, ${bakeDate || "no date"}`,
    tag: "order-admin",
    text:
      `Order ${orderRef}\n` +
      `Bake date: ${bakeDate || "unknown"}\n` +
      `Mode: ${mode ?? "unknown"}\n` +
      `ZIP: ${gate.zip ?? "not applicable"}\n` +
      `Pieces: ${intFrom(metadata, "piecesTotal")}\n` +
      `Counts toward the annual ceiling: ${contribution.capContributionCents} cents\n`,
  });

  deps.logger.info("webhook.order-recorded", {
    orderRef,
    sessionId: session.id,
    bakeDate,
    mode,
    capContributionCents: contribution.capContributionCents,
  });
}

/* ------------------------------------------------------------------ */
/* The refund path                                                     */
/* ------------------------------------------------------------------ */

interface RefundContext {
  readonly orderRef: string;
  readonly holdId: string | null;
  readonly bakeDate: string;
  readonly mode: FulfillmentMode | null;
  readonly gate: Extract<GateResult, { ok: false }>;
}

async function refundOutOfState(
  session: CompletedSession,
  deps: WebhookDeps,
  now: Date,
  context: RefundContext,
): Promise<void> {
  const paymentIntentId = paymentIntentIdOf(session);
  const customerEmail = session.customer_details?.email ?? null;

  deps.logger.warn("webhook.address-refused", {
    sessionId: session.id,
    orderRef: context.orderRef,
    code: context.gate.code,
    detail: context.gate.detail,
    mode: context.mode,
  });

  /* Give the bake day back first. Nobody is eating this order. */
  if (context.holdId !== null && context.holdId !== "") {
    await deps.store.releaseHold(context.holdId);
  }

  let refundId: string | null = null;
  let refunded = false;
  let refundFailure: string | null = null;

  if (paymentIntentId === null) {
    refundFailure = "The completed session carried no payment intent to refund.";
  } else {
    try {
      const refund = await deps.stripe.createRefund(
        {
          payment_intent: paymentIntentId,
          reason: "requested_by_customer",
          metadata: {
            orderRef: context.orderRef,
            reason: "outside-california",
            gate: context.gate.code,
          },
        },
        /*
          Keyed on the session, not on the event, so that a retried delivery
          of the same event, or a second event type for the same session,
          cannot issue a second refund.
        */
        { idempotencyKey: `refund:${session.id}` },
      );
      refundId = refund.id;
      refunded = true;
    } catch (cause) {
      /*
        The SDK already retried the transient cases. A failure that survives
        that needs a person, today, because money is sitting where it should
        not be. It is deliberately NOT rethrown: rethrowing would fail the
        event, Stripe would retry the whole handler, and the customer would
        be emailed an explanation again on every attempt. The flag below is
        the durable record that this needs doing by hand.
      */
      refundFailure = "Stripe refused the refund.";
      deps.logger.error("webhook.refund-failed", {
        sessionId: session.id,
        orderRef: context.orderRef,
        ...describeError(cause),
      });
    }
  }

  const contribution = capContributionFromSession(session);

  await deps.store.recordOrder({
    orderRef: context.orderRef,
    sessionId: session.id,
    paymentIntentId,
    status: refunded ? "refunded-out-of-state" : "refund-failed",
    bakeDate: context.bakeDate,
    mode: context.mode ?? "unknown",
    zip: null,
    lines: linesFrom(session.metadata),
    piecesTotal: intFrom(session.metadata, "piecesTotal"),
    amountTotalCents: typeof session.amount_total === "number" ? session.amount_total : 0,
    amountTaxCents: contribution.amountTaxCents,
    /*
      A refunded order is not revenue and contributes nothing to the annual
      ceiling. Counting it would close the store early over a sale that
      never happened.
    */
    capContributionCents: 0,
    customerEmail,
    createdAt: now.toISOString(),
  });

  await deps.store.flag({
    code: refunded ? "refunded-out-of-state" : "refund-failed",
    orderRef: context.orderRef,
    sessionId: session.id,
    detail: refunded
      ? `Refunded in full. ${context.gate.code}: ${context.gate.detail}`
      : `REFUND DID NOT GO THROUGH. ${refundFailure ?? "unknown"} ${context.gate.code}: ${context.gate.detail}`,
    createdAt: now.toISOString(),
    context: {
      refundId,
      paymentIntentId,
      mode: context.mode,
      gate: context.gate.code,
    },
  });

  if (customerEmail !== null) {
    await deps.emailer.send({
      to: customerEmail,
      subject: `Order ${context.orderRef} has been refunded in full`,
      tag: "refund-out-of-state",
      text:
        `The address on order ${context.orderRef} is outside California, and a home ` +
        `kitchen operation is only allowed to sell inside the state. The order has ` +
        `not been baked and the full amount has been refunded to the card you used. ` +
        `Refunds usually appear within five to ten business days.\n\n` +
        `If the address was a mistake, order again with a California address and it ` +
        `will go straight through. If you are ordering for somebody in California, ` +
        `use their address at checkout.\n\n` +
        `Sorry for the trouble. Write to ${deps.settings.contactEmail} and Hakop will help.`,
      replyTo: deps.settings.contactEmail,
    });
  }

  await deps.emailer.send({
    to: deps.settings.adminEmail,
    subject: refunded
      ? `Refunded out of state order ${context.orderRef}`
      : `ACTION NEEDED, refund failed on ${context.orderRef}`,
    tag: "refund-admin",
    text:
      `Order ${context.orderRef}\n` +
      `Session: ${session.id}\n` +
      `Payment intent: ${paymentIntentId ?? "none"}\n` +
      `Reason: ${context.gate.code}, ${context.gate.detail}\n` +
      `Refund: ${refunded ? `issued, ${refundId ?? "no id"}` : `NOT ISSUED. ${refundFailure ?? "unknown"}`}\n` +
      (refunded ? "" : "Issue this refund by hand in the Stripe dashboard today.\n"),
  });
}

/* ------------------------------------------------------------------ */
/* The annual ceiling                                                  */
/* ------------------------------------------------------------------ */

async function checkAnnualCap(
  deps: WebhookDeps,
  now: Date,
  orderRef: string,
  sessionId: string,
): Promise<void> {
  /*
    The ceiling is measured over the shop's calendar year, not the server's.
    A Netlify function runs in UTC, so an order taken at six in the evening
    on the thirty first of December in Cypress is already the first of
    January to `getUTCFullYear`, and reading the year off that clock files
    the last eight hours of the year's takings under the year that has not
    started. That is the direction that matters: the year being measured
    stops growing while sales are still being made against it.
  */
  const year = calendarYearIn(now, deps.settings.timeZone);
  const used = await deps.store.capTotalCents(year, deps.settings.timeZone);
  const meter = capMeter(used, deps.settings.annualCapCents);
  if (meter.level === "ok") return;

  await deps.store.flag({
    code: `annual-cap-${meter.level}`,
    orderRef,
    sessionId,
    detail:
      `Gross sales for the year are at ${Math.round(meter.fraction * 100)} percent of the ` +
      `Class A ceiling, counting product and shipping and excluding tax.`,
    createdAt: now.toISOString(),
    context: { usedCents: meter.usedCents, capCents: meter.capCents },
  });

  await deps.emailer.send({
    to: deps.settings.adminEmail,
    subject: `Annual sales ceiling at ${Math.round(meter.fraction * 100)} percent`,
    tag: "cap-meter",
    text:
      `Class A gross sales for this year are at ${Math.round(meter.fraction * 100)} percent ` +
      `of the ceiling.\n\nThis counts product revenue and shipping revenue and excludes ` +
      `sales tax collected.\n\nConfirm the current year figure with the county.\n`,
  });
}

/* ------------------------------------------------------------------ */
/* The real dependencies                                               */
/* ------------------------------------------------------------------ */

export default async (req: Request, _context: Context): Promise<Response> => {
  const secrets = stripeSecrets();
  const settings = shopSettings();

  /*
    Verification needs only the signing secret, so a deployment missing the
    API key can still tell a real delivery from a forged one. It cannot
    refund, and the refund path says so loudly if it is ever reached.
  */
  const stripe =
    secrets.secretKey === null
      ? {
          ...createVerifyOnlyGateway(),
          createRefund: async () => {
            throw new Error("STRIPE_SECRET_KEY is not set, so no refund can be issued.");
          },
        }
      : createStripeGateway(secrets.secretKey);

  return handleStripeWebhook(req, {
    now: () => new Date(),
    store: defaultOrderStore(),
    stripe,
    emailer: defaultEmailer(consoleLogger),
    fulfillment: fulfillmentConfigFromEnv(),
    settings,
    compliance: complianceConfig(),
    webhookSecret: secrets.webhookSecret,
    logger: consoleLogger,
  });
};
