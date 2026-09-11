/**
 * California ZIP codes.
 *
 * A Class A cottage food operation may sell only to customers inside
 * California. Section 5 of docs/ARCHITECTURE.md enforces that in three
 * independent places, and all three ask this module the same question, so the
 * answer and the words used to explain it are written down once, here.
 *
 * WHY A NUMERIC RANGE AND NOT A LOOKUP TABLE
 *
 * USPS hands out ZIP codes in geographic blocks, and California owns one
 * contiguous block: 90001 through 96162. Nothing inside that block belongs to
 * another state. Below it sits Nevada (889xx through 898xx). Above it the
 * 9xxxx space continues into overseas military addresses (962xx through
 * 966xx, APO and FPO AP), then Hawaii (967xx and 968xx), Guam and the Pacific
 * (969xx), Oregon (97xxx), Washington (980xx through 994xx) and Alaska
 * (995xx through 999xx). So two integer comparisons answer the question
 * exactly, in a few bytes, with no data to go stale.
 *
 * A full table of assigned ZIP codes would be thousands of entries shipped to
 * every phone, it would be wrong within months, and it would buy very little:
 * a number inside the California range that nobody lives at still fails later,
 * at the address itself, where Stripe and the delivery run both check it. This
 * gate exists to keep out of state customers out, not to audit the mail.
 *
 * Pure logic. No DOM, no environment reads, no network. It runs in the
 * browser, in a Netlify function, and at build time.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * The only two ways a ZIP can fail this check. Exported as values so the
 * islands, the Netlify functions and the pages all branch on the same strings
 * instead of each inventing their own.
 */
export const ZIP_REJECTION_REASONS = ["malformed", "out-of-state"] as const;

export type ZipRejectionReason = (typeof ZIP_REJECTION_REASONS)[number];

/**
 * Plain language for each reason, in the shop's voice. A caller is free to
 * write its own sentence, but if it does not care to, it should use these so
 * the cart, the contact form and the checkout all say the same thing.
 */
export const ZIP_REJECTION_MESSAGES: Readonly<Record<ZipRejectionReason, string>> = {
  malformed: "That does not look like a five digit ZIP code.",
  "out-of-state":
    "That ZIP code is outside California. A home kitchen operation can only " +
    "sell inside the state.",
};

export function zipRejectionMessage(reason: ZipRejectionReason): string {
  return ZIP_REJECTION_MESSAGES[reason];
}

/** A validated five digit California ZIP, or the reason it was refused. */
export type CaliforniaZipResult =
  | { readonly ok: true; readonly zip: string }
  | { readonly ok: false; readonly reason: ZipRejectionReason };

/* ------------------------------------------------------------------ */
/* Range                                                               */
/* ------------------------------------------------------------------ */

/** Lowest California ZIP. Los Angeles. */
export const CALIFORNIA_ZIP_MIN = 90_001;

/** Highest California ZIP. Truckee, up in Nevada County. */
export const CALIFORNIA_ZIP_MAX = 96_162;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Five digits, and nothing else. */
const FIVE_DIGITS = /^\d{5}$/;

/**
 * ZIP+4, with or without the hyphen. Browsers autofill both shapes and the
 * address a customer pastes from an order confirmation usually carries the
 * plus four, so accepting it and keeping the first five is kinder than
 * refusing a ZIP that is perfectly correct.
 */
const ZIP_PLUS_FOUR = /^(\d{5})[- ]?\d{4}$/;

/**
 * Reduce any accepted spelling of a ZIP to its five digit form.
 *
 * Returns null rather than throwing, because this runs on every keystroke in
 * a form field where "906" is a normal thing for a half typed value to be.
 * Takes unknown because at the Netlify function boundary the value really is
 * unknown: it arrives as parsed JSON that nobody has checked yet.
 */
export function normalizeZip(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (FIVE_DIGITS.test(trimmed)) return trimmed;
  const plusFour = ZIP_PLUS_FOUR.exec(trimmed);
  return plusFour?.[1] ?? null;
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Is this a California ZIP?
 *
 * Returns a discriminated result rather than a boolean on purpose. The
 * customer who typed four digits and the customer who lives in Nevada both
 * get false from a boolean, and they need to be told two completely different
 * things. Carrying the reason means the sentence shown to them is chosen
 * once, here, and never guessed at in a template.
 *
 * On success the normalized five digit ZIP comes back with the result, so the
 * caller stores the clean value rather than whatever was typed.
 */
export function isCaliforniaZip(input: unknown): CaliforniaZipResult {
  const zip = normalizeZip(input);
  if (zip === null) return { ok: false, reason: "malformed" };

  // Parsed after the shape check, so leading zeros (00501, Holtsville NY)
  // are refused as out of state rather than silently becoming 501.
  const numeric = Number.parseInt(zip, 10);
  if (numeric < CALIFORNIA_ZIP_MIN || numeric > CALIFORNIA_ZIP_MAX) {
    return { ok: false, reason: "out-of-state" };
  }

  return { ok: true, zip };
}

/**
 * Boolean convenience for the places that genuinely only need yes or no, such
 * as filtering a configured list of delivery ZIPs. Anything customer facing
 * should use isCaliforniaZip and show the reason.
 */
export function isCaliforniaZipLoose(input: unknown): boolean {
  return isCaliforniaZip(input).ok;
}
