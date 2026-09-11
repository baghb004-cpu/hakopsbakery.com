/**
 * Single source of truth for everything the law requires this site to say.
 *
 * Read Section 4 of docs/BRIEF.md before changing anything in this file.
 * A cottage food operation that advertises to the public, and that includes
 * its own website, must display the county of approval, the registration
 * number, and a "Made in a Home Kitchen" statement. Those three values are
 * driven from environment config so that nothing is ever typed into a
 * template and quietly drifts out of date.
 *
 * Nothing here is a secret. Every value in this file is public by design.
 * Secrets live in the Netlify function environment and never reach the client.
 */

import { HOME_KITCHEN_STATEMENT, DISCLOSURE_VERSION } from "./compliance-text";

const env = import.meta.env;

/** Trim, then treat an empty string the same as an absent variable. */
function readEnv(key: string): string | null {
  const raw = (env as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function readBool(key: string): boolean {
  const value = readEnv(key)?.toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function readInt(key: string, fallback: number): number {
  const value = readEnv(key);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* --------------------------------------------------------------------------
   Identity
   -------------------------------------------------------------------------- */

export const business = {
  /** Must match the name registered with the county and printed on the label. */
  name: readEnv("PUBLIC_BUSINESS_NAME") ?? "Hakop's Bakery",
  /** Short form for tight spaces. Never used where the legal name is required. */
  shortName: "Hakop's Bakery",
  owner: "Hakop Baghdasarian",
  /**
   * The address that appears on the label and in the footer.
   *
   * OPEN DECISION, docs/DECISIONS.md D-003. Publishing a home address is a
   * real safety and privacy choice and it has not been made yet. Until it is,
   * this stays empty and the footer shows the city only.
   */
  address: readEnv("PUBLIC_BUSINESS_ADDRESS"),
  city: "Cypress",
  state: "CA",
  /** Contact details are config, not literals, so they can change in one place. */
  email: readEnv("PUBLIC_CONTACT_EMAIL") ?? "hello@hakopsbakery.com",
  /** Deliberately not the personal mobile number. See DECISIONS.md D-010. */
  phone: readEnv("PUBLIC_CONTACT_PHONE"),
  instagram: readEnv("PUBLIC_INSTAGRAM_HANDLE"),
} as const;

export const site = {
  url: readEnv("PUBLIC_SITE_URL") ?? "https://hakopsbakery.com",
  locale: "en-US",
  /** Armenian copy ships behind a toggle in Phase 3. Section 13 of the brief. */
  altLocale: "hy-AM",
  title: `${business.name}, Armenian gata baked in Cypress, California`,
  /*
    This is the sentence a search result and a shared link show, so it has to
    be true in both states. The old wording ended "Order for pickup, local
    delivery, or shipping anywhere in the state", which invited an order the
    site cannot take while the registration is pending. It describes the
    business instead, and it says nothing the home page does not.
  */
  description:
    "Armenian gata, baked by hand by Hakop Baghdasarian in Cypress, " +
    "California, and sold by the tray. Pickup, local delivery and shipping " +
    "inside California.",
} as const;

/* --------------------------------------------------------------------------
   Cottage food compliance
   -------------------------------------------------------------------------- */

export const compliance = {
  /**
   * Issued by Orange County Environmental Health. Empty until the
   * registration is in hand. scripts/preflight.mjs refuses to produce a
   * production build with the store open while this is empty.
   */
  registrationNumber: readEnv("PUBLIC_CFO_REGISTRATION_NUMBER"),
  county: readEnv("PUBLIC_CFO_COUNTY") ?? "Orange County",
  /** Class A covers direct sales to the end customer. Section 3, Step 1. */
  operationClass: "A",
  /* Fixed legal wording, from the one module both the pages and the
     Netlify functions read. See src/config/compliance-text.ts. */
  homeKitchenStatement: HOME_KITCHEN_STATEMENT,
  disclosureVersion: DISCLOSURE_VERSION,
  /** ISO date. The admin warns at 60 and 30 days out. Section 12. */
  registrationExpiry: readEnv("PUBLIC_CFO_EXPIRY"),
  sellersPermit: readEnv("PUBLIC_SELLERS_PERMIT"),
} as const;

/**
 * True only when every value the law requires is actually present.
 * The storefront reads this, not the raw registration number.
 */
export const complianceIsComplete: boolean =
  compliance.registrationNumber !== null && compliance.county !== null;

/* --------------------------------------------------------------------------
   The launch gate
   -------------------------------------------------------------------------- */

/**
 * When false the site is a coming soon page: story, product, photography and
 * an email capture, with no cart and no prices presented as purchasable.
 *
 * The store cannot open without a registration number even if someone sets
 * the flag by hand, because the footer would then be advertising a number
 * that does not exist. Both conditions have to hold.
 */
export const storeOpen: boolean = readBool("PUBLIC_STORE_OPEN") && complianceIsComplete;

/* --------------------------------------------------------------------------
   Commerce rules
   -------------------------------------------------------------------------- */

export const commerce = {
  currency: "usd",
  /**
   * Class A annual gross sales ceiling. The statute sets 75,000 dollars with
   * an annual CPI adjustment. VERIFY the current year figure with the county
   * before trusting the meter. Product revenue plus shipping revenue count.
   * Sales tax collected does not.
   */
  annualCapCents: readInt("CFO_ANNUAL_CAP_CENTS", 8_600_000),
  capWarnAt: 0.7,
  capWarnLoudlyAt: 0.85,
  /** Direct to consumer, inside California, only. This is not configurable. */
  allowedStates: ["CA"] as const,
  allowedCountries: ["US"] as const,
  /** Orders for a bake date close at this hour, this many days before it. */
  cutoff: { hour: 20, daysBefore: 2 },
  /** Hakop has class Tuesdays 8am to 3pm. Never schedule a bake day then. */
  neverBakeWeekdays: [2] as const,
  timezone: "America/Los_Angeles",
} as const;

/* --------------------------------------------------------------------------
   Analytics
   -------------------------------------------------------------------------- */

export const analytics = {
  /**
   * Cloudflare Web Analytics. Roughly one kilobyte, no cookies, no consent
   * banner, and the domain is already on Cloudflare so it adds no new vendor.
   * Deliberately not Google Analytics: forty five kilobytes of third party
   * script would cost real Lighthouse points on the exact pages that need to
   * be fastest. See docs/DECISIONS.md D-002.
   */
  cloudflareToken: readEnv("PUBLIC_CF_ANALYTICS_TOKEN"),
} as const;
