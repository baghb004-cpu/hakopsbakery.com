/**
 * Fixed legal wording. The single source of truth.
 *
 * These three strings are not configuration. They are required wording, they
 * are printed on the physical label, and a customer's recorded consent points
 * at a specific version of them. So they are not environment variables, and
 * they must not exist in two places.
 *
 * WHY THIS FILE IS SEPARATE FROM site.ts
 *
 * src/config/site.ts reads import.meta.env, which Vite fills in at build time.
 * A Netlify function is bundled by esbuild and runs in plain Node, where
 * import.meta.env is undefined, so a function importing site.ts throws on the
 * first property read. This file reads nothing at all, so both sides can
 * import it: the pages through site.ts, and the functions directly.
 *
 * CHANGING ANY OF THESE IS A TWO PLACE CHANGE
 *
 * The printed label and this file have to say the same thing, word for word.
 * If the county asks for different wording, update docs/COMPLIANCE.md and the
 * label artwork in the same change, and bump DISCLOSURE_VERSION so that
 * consent recorded before the change is still attributable to the sentence
 * the customer actually read.
 */

/**
 * Required on the label and anywhere the operation advertises to the public,
 * which includes this website. Do not paraphrase it.
 */
export const HOME_KITCHEN_STATEMENT =
  "Made in a home kitchen that is not inspected by the Department of Public Health.";

/**
 * Stamped onto every recorded consent so that, a year from now, it is
 * possible to prove which sentence a given customer agreed to. Bump it
 * whenever HOME_KITCHEN_STATEMENT or CONSENT_ACKNOWLEDGEMENT changes.
 */
export const DISCLOSURE_VERSION = "2026-09-11.a";

/** What the customer ticks at checkout, stored word for word with the order. */
export const CONSENT_ACKNOWLEDGEMENT =
  "I have read the home kitchen statement above and I understand it.";
