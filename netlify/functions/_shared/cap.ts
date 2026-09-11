/**
 * The Class A annual gross sales ceiling, measured.
 *
 * Section 4 and Section 12 of docs/BRIEF.md: the ceiling counts product
 * revenue plus shipping revenue, and it EXCLUDES the sales tax collected.
 * Sales tax is money held for the state, it was never revenue, and counting
 * it would close the store early for no reason.
 *
 * Getting this wrong in the other direction is worse. Leaving shipping out
 * would under count, the meter would read low, and the first anyone would
 * know about crossing a statutory limit is somebody from the county asking
 * about it. So both halves are explicit and both are tested.
 *
 * Stripe's own arithmetic, for reference:
 *
 *   amount_total = amount_subtotal
 *                - total_details.amount_discount
 *                + total_details.amount_shipping
 *                + total_details.amount_tax
 *
 * which makes the contribution simply amount_total minus the tax. The
 * breakdown is recomputed independently below as a cross check, because a
 * money number that is only produced one way is a money number nobody has
 * checked.
 */

/** The five amounts a completed Checkout Session carries. All in cents. */
export interface SessionAmounts {
  readonly amountTotalCents: number;
  readonly amountSubtotalCents: number;
  readonly amountTaxCents: number;
  readonly amountShippingCents: number;
  readonly amountDiscountCents: number;
}

export interface CapContribution {
  /** Product plus shipping, net of discounts, excluding tax. */
  readonly capContributionCents: number;
  readonly amountTaxCents: number;
  /** The same figure worked out from the breakdown rather than the total. */
  readonly crossCheckCents: number;
  /** False when the two disagree, which means something needs a human. */
  readonly consistent: boolean;
}

function whole(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Pull the amounts off whatever shape the session arrived in.
 *
 * Written against an unknown rather than a Stripe type on purpose: this runs
 * on a webhook payload, and a payload is a wire format that can be missing
 * fields. Everything absent counts as zero, and a session with no total
 * contributes nothing rather than throwing inside a webhook.
 */
export function sessionAmounts(session: unknown): SessionAmounts {
  const record = (session ?? {}) as Record<string, unknown>;
  const totals = (record["total_details"] ?? {}) as Record<string, unknown>;
  const shippingCost = (record["shipping_cost"] ?? {}) as Record<string, unknown>;

  /*
    total_details.amount_shipping is the figure Stripe reports for the
    shipping line. shipping_cost.amount_subtotal is the same money seen from
    the shipping rate. Prefer the first and fall back to the second, because
    an older API version fills in one and not the other.
  */
  const shipping =
    totals["amount_shipping"] === null || totals["amount_shipping"] === undefined
      ? whole(shippingCost["amount_subtotal"] as number | undefined)
      : whole(totals["amount_shipping"] as number);

  return {
    amountTotalCents: whole(record["amount_total"] as number | undefined),
    amountSubtotalCents: whole(record["amount_subtotal"] as number | undefined),
    amountTaxCents: whole(totals["amount_tax"] as number | undefined),
    amountShippingCents: shipping,
    amountDiscountCents: whole(totals["amount_discount"] as number | undefined),
  };
}

export function capContribution(amounts: SessionAmounts): CapContribution {
  const fromTotal = amounts.amountTotalCents - amounts.amountTaxCents;
  const fromBreakdown =
    amounts.amountSubtotalCents - amounts.amountDiscountCents + amounts.amountShippingCents;

  return {
    capContributionCents: Math.max(0, fromTotal),
    amountTaxCents: amounts.amountTaxCents,
    crossCheckCents: Math.max(0, fromBreakdown),
    consistent: fromTotal === fromBreakdown,
  };
}

/** Convenience for the webhook, which has a raw session and wants a number. */
export function capContributionFromSession(session: unknown): CapContribution {
  return capContribution(sessionAmounts(session));
}

/* ------------------------------------------------------------------ */
/* The meter                                                           */
/* ------------------------------------------------------------------ */

export type CapLevel = "ok" | "warn" | "loud" | "over";

export interface CapMeter {
  readonly usedCents: number;
  readonly capCents: number;
  readonly remainingCents: number;
  /** Zero to one, and past one when the ceiling has been crossed. */
  readonly fraction: number;
  readonly level: CapLevel;
}

/**
 * Where the year stands. The admin renders this; the thresholds are the ones
 * in the brief, 70 percent for a quiet warning and 85 percent for a loud one.
 */
export function capMeter(
  usedCents: number,
  capCents: number,
  thresholds: { warnAt: number; loudAt: number } = { warnAt: 0.7, loudAt: 0.85 },
): CapMeter {
  const cap = Math.max(0, Math.round(capCents));
  const used = Math.max(0, Math.round(usedCents));
  const fraction = cap === 0 ? 0 : used / cap;

  const level: CapLevel =
    cap === 0 ? "ok" : used >= cap ? "over" : fraction >= thresholds.loudAt ? "loud" : fraction >= thresholds.warnAt ? "warn" : "ok";

  return {
    usedCents: used,
    capCents: cap,
    remainingCents: Math.max(0, cap - used),
    fraction,
    level,
  };
}
