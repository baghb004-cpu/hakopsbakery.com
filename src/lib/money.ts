/**
 * Money.
 *
 * Every amount in this codebase is an integer number of cents. Nothing here
 * ever multiplies, adds or rounds a dollar figure as a float, because binary
 * floating point cannot hold a tenth exactly and the errors compound quietly
 * until a total is off by a cent and a customer notices before you do.
 *
 * Stripe works in the smallest currency unit for the same reason. Keeping the
 * same representation end to end means there is never a conversion step where
 * a rounding decision has to be invented.
 *
 * Display only. The browser is never the authority on a price: it sends a sku,
 * a variant id and a quantity, and `create-checkout-session` looks the real
 * figure up server side. Section 8 of docs/ARCHITECTURE.md.
 *
 * No Astro imports on purpose, so a Netlify function can use this too.
 */

/** ISO 4217. The store sells in one currency and is not built for more. */
export const CURRENCY = "USD";

const LOCALE = "en-US";

/*
  Intl.NumberFormat is expensive to construct and cheap to reuse, and this
  runs once per price on a page that may list many. Build them once.
*/
const FULL = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
});

const WHOLE = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const COUNT = new Intl.NumberFormat(LOCALE);

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * Refuse anything that is not a whole number of cents. A float reaching this
 * layer means somebody did arithmetic in dollars upstream, and the right time
 * to find that out is the first render, not the first refund.
 */
export function assertCents(value: number, what = "amount"): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${what} must be a whole number of cents. Received ${String(value)}. ` +
        "Money is never a float in this codebase.",
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cents to a full price string.
 *
 *   formatMoney(2800)  gives  "$28.00"
 *   formatMoney(-500)  gives  "-$5.00"
 */
export function formatMoney(cents: number): string {
  assertCents(cents, "price");
  return FULL.format(cents / 100);
}

/**
 * The same, with the trailing zeroes dropped when there is no change.
 *
 *   formatMoneyShort(2800)  gives  "$28"
 *   formatMoneyShort(2850)  gives  "$28.50"
 *
 * Use this on cards and in headings, where a column of ".00" is noise. Use the
 * full form anywhere the number is part of a total a customer is checking.
 */
export function formatMoneyShort(cents: number): string {
  assertCents(cents, "price");
  return cents % 100 === 0 ? WHOLE.format(cents / 100) : FULL.format(cents / 100);
}

/**
 * A price range, for a product with more than one size.
 *
 *   formatMoneyRange(2800, 5200)  gives  "$28 to $52"
 *
 * Written out rather than punctuated, because a dash between two prices reads
 * as a minus sign at small sizes and this site has no em dashes anywhere.
 */
export function formatMoneyRange(lowCents: number, highCents: number): string {
  assertCents(lowCents, "low price");
  assertCents(highCents, "high price");
  if (lowCents === highCents) return formatMoneyShort(lowCents);
  const [low, high] =
    lowCents <= highCents ? [lowCents, highCents] : [highCents, lowCents];
  return `${formatMoneyShort(low)} to ${formatMoneyShort(high)}`;
}

/** A quantity, grouped, for the cart and the admin. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

/* ------------------------------------------------------------------ */
/* Arithmetic, in integers only                                        */
/* ------------------------------------------------------------------ */

/** A line total. Integers in, integer out, no rounding decision to make. */
export function multiplyMoney(cents: number, quantity: number): number {
  assertCents(cents, "unit price");
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError(`quantity must be a whole number, received ${String(quantity)}.`);
  }
  return assertCents(cents * quantity, "line total");
}

/** A cart total. */
export function sumMoney(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) total += assertCents(amount, "amount");
  return assertCents(total, "total");
}

/**
 * A percentage of an amount, for tax or a discount, rounded half up to the
 * cent. Rounding is explicit and happens exactly once, here, rather than
 * being an accident of how a float happened to land.
 *
 * `basisPoints` is hundredths of a percent, so 875 is 8.75 percent.
 */
export function percentOfMoney(cents: number, basisPoints: number): number {
  assertCents(cents, "amount");
  if (!Number.isSafeInteger(basisPoints)) {
    throw new TypeError("basisPoints must be a whole number.");
  }
  const scaled = cents * basisPoints;
  const rounded = Math.round(Math.abs(scaled) / 10_000);
  return assertCents(scaled < 0 ? -rounded : rounded, "result");
}

/**
 * Parse a typed dollar figure into cents without ever creating a float.
 *
 *   dollarsToCents("28")     gives  2800
 *   dollarsToCents("28.5")   gives  2850
 *   dollarsToCents("28.50")  gives  2850
 *
 * This takes a string on purpose. If the caller has a number in dollars, the
 * damage is already done: 19.99 is not 19.99 in binary and no parse can undo
 * that. Admin forms hand over the raw input, which is what this wants.
 */
export function dollarsToCents(input: string): number {
  const trimmed = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new TypeError(
      `Not a dollar amount: ${JSON.stringify(input)}. ` +
        'Expected something like "28" or "28.50".',
    );
  }
  const [, sign, whole = "0", fraction = ""] = match;
  const cents =
    Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
  return assertCents(sign === "-" ? -cents : cents, "parsed amount");
}

/** The plain decimal form, for a CSV export or a Stripe metadata field. */
export function centsToDecimalString(cents: number): string {
  assertCents(cents, "amount");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Tabular display                                                     */
/* ------------------------------------------------------------------ */

/**
 * Figures that change in place, a cart total or a quantity stepper, must not
 * jitter as the digits change width. `global.css` gives tabular figures to
 * `.tabular`, to `[data-price]` and to `[data-qty]`.
 */
export const TABULAR_CLASS = "tabular";

/**
 * Attributes for an element showing a price. Spread it:
 *
 *   <span {...moneyAttrs(variant.priceCents)}>{formatMoney(variant.priceCents)}</span>
 *
 * `data-price` carries the integer cents, so a test, an analytics hook or a
 * human in devtools reads the real figure rather than a formatted string.
 */
export function moneyAttrs(cents: number): {
  class: string;
  "data-price": string;
} {
  assertCents(cents, "price");
  return { class: TABULAR_CLASS, "data-price": String(cents) };
}

/** The same for a count, so a stepper does not shift when it passes nine. */
export function countAttrs(value: number): {
  class: string;
  "data-qty": string;
} {
  return { class: TABULAR_CLASS, "data-qty": String(value) };
}
