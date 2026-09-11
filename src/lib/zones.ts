/**
 * Fulfillment: pickup, local delivery, and shipping inside California.
 *
 * Pure logic. No DOM, no environment reads, no network. The delivery area,
 * the fee and the minimum order all arrive as configuration, because they are
 * Hakop's decisions and they will change. Nothing in this file is a price.
 *
 * Three modes, three different questions:
 *
 *   pickup     Does not depend on a ZIP at all. The customer comes to the
 *              door, so the only thing that can refuse them is the mode being
 *              switched off.
 *   delivery   A short list of ZIPs Hakop can reasonably drive to and back
 *              from in an afternoon.
 *   shipping   Anywhere in California. The state line is the whole rule,
 *              which is why it lives in california.ts and not here.
 *
 * Every refusal comes back with a reason from one small vocabulary and a
 * sentence written in the shop's voice. The cart, the fulfillment island and
 * the Netlify functions all read from the same two lists, so a customer is
 * never told one thing on the page and another at checkout.
 */

import { isCaliforniaZip, normalizeZip, zipRejectionMessage } from "./california";
import { formatMoneyShort } from "./money";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const FULFILLMENT_MODES = ["pickup", "delivery", "shipping"] as const;

export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export const FULFILLMENT_DENIAL_REASONS = [
  "mode-unavailable",
  "zip-missing",
  "zip-malformed",
  "out-of-state",
  "outside-delivery-area",
  "below-minimum",
] as const;

export type FulfillmentDenialReason = (typeof FULFILLMENT_DENIAL_REASONS)[number];

/** Sentence case labels for the three modes, used inside the messages. */
const MODE_LABELS: Readonly<Record<FulfillmentMode, string>> = {
  pickup: "Pickup",
  delivery: "Delivery",
  shipping: "Shipping",
};

export function fulfillmentModeLabel(mode: FulfillmentMode): string {
  return MODE_LABELS[mode];
}

export function isFulfillmentMode(value: unknown): value is FulfillmentMode {
  return typeof value === "string" && (FULFILLMENT_MODES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface ModeConfig {
  /** False turns the mode off everywhere at once, with one clear sentence. */
  readonly available: boolean;
  /** Flat fee in cents. Cents, never dollars, and never a float. */
  readonly feeCents: number;
  /** Smallest order this mode accepts, in cents. Zero means no minimum. */
  readonly minimumOrderCents: number;
}

export interface DeliveryConfig extends ModeConfig {
  /** Five digit ZIPs Hakop will drive to. See DEFAULT_DELIVERY_ZIPS. */
  readonly zips: readonly string[];
}

export interface FulfillmentConfig {
  readonly pickup: ModeConfig;
  readonly delivery: DeliveryConfig;
  readonly shipping: ModeConfig;
}

/*
  TODO, brief open decision 4: HAKOP MUST CONFIRM THIS LIST.

  This is a first draft of the local delivery area, not a decision. It covers
  Cypress and the towns named in the brief as the surrounding ones, using the
  ZIPs that take street delivery. PO box only ZIPs are left out on purpose,
  because a tray cannot be left in a PO box.

  Two things need his answer before this ships:
    1. Whether the whole of Anaheim and Garden Grove is really in range, or
       only the parts nearest Cypress. Anaheim Hills is a long way east.
    2. Whether he wants to deliver at all on a bake day, or only the morning
       after.

  Until then the list is wide rather than narrow, and it is wrong to treat it
  as final. Nothing in the codebase reads it except as a default argument.
*/
export const DEFAULT_DELIVERY_ZIPS: readonly string[] = [
  "90620", // Buena Park
  "90621", // Buena Park
  "90623", // La Palma
  "90630", // Cypress
  "90680", // Stanton
  "90703", // Cerritos
  "90720", // Los Alamitos
  "92801", // Anaheim
  "92802", // Anaheim
  "92804", // Anaheim
  "92805", // Anaheim
  "92806", // Anaheim
  "92807", // Anaheim
  "92808", // Anaheim
  "92840", // Garden Grove
  "92841", // Garden Grove
  "92843", // Garden Grove
  "92844", // Garden Grove
  "92845", // Garden Grove
];

/*
  Placeholder configuration. The ZIP list is a real draft; every number below
  is a zero standing in for a decision Hakop has not made.

  Zero is the deliberate choice for both the fee and the minimum. A fee that
  is wrong high overcharges a real customer, and a minimum that is wrong high
  turns one away. Both of those are worse than a fee of nothing, which is at
  least honest about the fact that nobody has set it yet. Callers should pass
  their own configuration and not lean on this.
*/
export const DEFAULT_FULFILLMENT_CONFIG: FulfillmentConfig = {
  pickup: { available: true, feeCents: 0, minimumOrderCents: 0 },
  delivery: {
    available: true,
    feeCents: 0,
    minimumOrderCents: 0,
    zips: DEFAULT_DELIVERY_ZIPS,
  },
  shipping: { available: true, feeCents: 0, minimumOrderCents: 0 },
};

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface FulfillmentAllowed {
  readonly ok: true;
  readonly mode: FulfillmentMode;
  /** Normalized five digit ZIP, or null for pickup, which does not use one. */
  readonly zip: string | null;
  readonly feeCents: number;
  readonly minimumOrderCents: number;
}

export interface FulfillmentRefused {
  readonly ok: false;
  readonly mode: FulfillmentMode;
  readonly zip: string | null;
  readonly reason: FulfillmentDenialReason;
  /** Plain language, ready to put in front of a customer. */
  readonly message: string;
  /** Cents still needed to clear the minimum. Null for every other reason. */
  readonly shortfallCents: number | null;
}

export type FulfillmentResult = FulfillmentAllowed | FulfillmentRefused;

/* ------------------------------------------------------------------ */
/* Delivery area                                                       */
/* ------------------------------------------------------------------ */

/**
 * Is this ZIP inside the local delivery area?
 *
 * Both sides are normalized before comparing, so a ZIP+4 from an autofilled
 * form matches a five digit entry in the configuration, and a stray space in
 * either does not quietly exclude someone.
 */
export function isInDeliveryArea(zip: unknown, zips: readonly string[]): boolean {
  const normalized = normalizeZip(zip);
  if (normalized === null) return false;
  return zips.some((candidate) => normalizeZip(candidate) === normalized);
}

/**
 * Configured ZIPs that are not in California, if any. Nothing calls this in
 * the request path: it is here so a build check or the admin can catch a typo
 * in the delivery list before a customer does.
 */
export function nonCaliforniaDeliveryZips(zips: readonly string[]): readonly string[] {
  return zips.filter((zip) => !isCaliforniaZip(zip).ok);
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * Fees and minimums are whole cents, and a configuration value that is not a
 * number is treated as nothing rather than thrown.
 *
 * This is the one place in the module that swallows bad input. A broken fee
 * should not take the fulfillment picker down with it: the customer still
 * needs to choose a bake date, and a fee of zero is visibly wrong to Hakop in
 * a way that a blank page is not. Amounts reaching money.ts are integers by
 * the time they leave here, which is what formatMoneyShort insists on.
 */
function centsFromConfig(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

function refuse(
  mode: FulfillmentMode,
  zip: string | null,
  reason: FulfillmentDenialReason,
  message: string,
  shortfallCents: number | null = null,
): FulfillmentRefused {
  return { ok: false, mode, zip, reason, message, shortfallCents };
}

function configFor(mode: FulfillmentMode, config: FulfillmentConfig): ModeConfig {
  return mode === "pickup"
    ? config.pickup
    : mode === "delivery"
      ? config.delivery
      : config.shipping;
}

/**
 * Can this customer use this mode, and what does it cost?
 *
 * Checks run cheapest and most general first, so the sentence a customer sees
 * is the most useful one available. Telling someone in Oregon that they are
 * short of the delivery minimum would be true and useless: they are in
 * Oregon, and that is the thing they need to hear.
 *
 * subtotalCents is optional because the minimum cannot always be judged. The
 * ZIP checker on the contact page has no cart behind it, and it should still
 * be able to answer "yes, I come to your street". Pass the subtotal wherever
 * there is one, which means everywhere in the cart and the checkout function.
 *
 * The fee comes back in cents and is never recalculated in the browser. The
 * checkout function resolves it again server side from the same configuration
 * before it builds a Stripe session.
 */
export function resolveFulfillment(
  mode: FulfillmentMode,
  zip: unknown,
  config: FulfillmentConfig,
  subtotalCents?: number,
): FulfillmentResult {
  const modeConfig = configFor(mode, config);
  const label = fulfillmentModeLabel(mode);

  if (!modeConfig.available) {
    return refuse(
      mode,
      null,
      "mode-unavailable",
      `${label} is not available right now.`,
    );
  }

  // Pickup happens at the door, so a ZIP tells us nothing and is ignored
  // rather than validated. Asking a customer for one would be theatre.
  let resolvedZip: string | null = null;

  if (mode !== "pickup") {
    const raw = typeof zip === "string" ? zip.trim() : "";
    if (raw.length === 0) {
      return refuse(
        mode,
        null,
        "zip-missing",
        `Enter a ZIP code and we will check ${label.toLowerCase()}.`,
      );
    }

    const california = isCaliforniaZip(raw);
    if (!california.ok) {
      const reason = california.reason === "malformed" ? "zip-malformed" : "out-of-state";
      return refuse(mode, null, reason, zipRejectionMessage(california.reason));
    }
    resolvedZip = california.zip;

    if (mode === "delivery" && !isInDeliveryArea(resolvedZip, config.delivery.zips)) {
      return refuse(
        mode,
        resolvedZip,
        "outside-delivery-area",
        "That ZIP code is outside the local delivery run. Pickup in Cypress " +
          "and shipping anywhere in California are both open to you.",
      );
    }
  }

  const minimum = centsFromConfig(modeConfig.minimumOrderCents);
  if (subtotalCents !== undefined && minimum > 0) {
    const subtotal = Number.isFinite(subtotalCents) ? Math.round(subtotalCents) : 0;
    if (subtotal < minimum) {
      return refuse(
        mode,
        resolvedZip,
        "below-minimum",
        `${label} orders start at ${formatMoneyShort(minimum)}.`,
        minimum - subtotal,
      );
    }
  }

  return {
    ok: true,
    mode,
    zip: resolvedZip,
    feeCents: centsFromConfig(modeConfig.feeCents),
    minimumOrderCents: minimum,
  };
}

/**
 * Which modes are open to a given ZIP, in the order they should be offered.
 *
 * Pickup first because it costs nothing and it is how most of these orders
 * will actually move. The picker uses this to decide which options to show
 * rather than showing all three and refusing two of them after the fact.
 */
export function availableFulfillmentModes(
  zip: unknown,
  config: FulfillmentConfig,
): readonly FulfillmentMode[] {
  return FULFILLMENT_MODES.filter((mode) => resolveFulfillment(mode, zip, config).ok);
}
