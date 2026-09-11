/**
 * Server side configuration for the Netlify functions.
 *
 * WHY THIS FILE EXISTS AND DOES NOT SIMPLY IMPORT src/config/site.ts
 *
 * `src/config/site.ts` reads `import.meta.env`, which Vite fills in at build
 * time. A Netlify function is bundled by esbuild and runs in plain Node,
 * where `import.meta.env` is undefined, so importing that module from a
 * function throws on the first property read. The variable NAMES below are
 * deliberately the same ones `site.ts` reads, so a value set once in Netlify
 * reaches the page and the function without being typed twice.
 *
 * Two constants are duplicated rather than read from an environment
 * variable: the home kitchen statement and the disclosure version. Both are
 * fixed legal wording, not configuration. `tests/compliance-wording.test.ts`
 * imports `src/config/site.ts` and fails if the two copies ever drift, which
 * is the guard that makes the duplication safe. See the note in the summary
 * about the one line change to `site.ts` that would remove it entirely.
 *
 * Nothing here reads a secret into a value that is ever returned to a
 * browser. Secrets are fetched at the point of use and never logged.
 */

import {
  HOME_KITCHEN_STATEMENT,
  DISCLOSURE_VERSION,
  CONSENT_ACKNOWLEDGEMENT,
} from "@config/compliance-text";
import { DEFAULT_FULFILLMENT_CONFIG } from "@lib/zones";
import type { FulfillmentConfig } from "@lib/zones";
import type { BakeScheduleConfig, Weekday } from "@lib/bake-schedule";
import { isCalendarDate } from "@lib/bake-schedule";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

type Env = Record<string, string | undefined>;

function source(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** Trim, then treat an empty string exactly like an absent variable. */
export function env(key: string, from: Env = source()): string | null {
  const raw = from[key];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function envBool(key: string, from: Env = source()): boolean {
  const value = env(key, from)?.toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function envInt(key: string, fallback: number, from: Env = source()): number {
  const value = env(key, from);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Comma or space separated list. Returns null when the variable is absent. */
export function envList(key: string, from: Env = source()): string[] | null {
  const value = env(key, from);
  if (value === null) return null;
  const parts = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : null;
}

/* ------------------------------------------------------------------ */
/* Compliance                                                          */
/* ------------------------------------------------------------------ */

/*
  The fixed legal wording comes from the one module that both the pages and
  these functions can import. It reads no environment of any kind, so it is
  safe on both sides of the Vite and esbuild divide. Previously these three
  constants were restated here and guarded only by a drift test.
*/
export {
  HOME_KITCHEN_STATEMENT,
  DISCLOSURE_VERSION,
  CONSENT_ACKNOWLEDGEMENT,
} from "@config/compliance-text";

export interface ComplianceConfig {
  readonly registrationNumber: string | null;
  readonly county: string | null;
  readonly statement: string;
  readonly acknowledgement: string;
  readonly disclosureVersion: string;
  readonly complete: boolean;
}

export function complianceConfig(from: Env = source()): ComplianceConfig {
  const registrationNumber = env("PUBLIC_CFO_REGISTRATION_NUMBER", from);
  const county = env("PUBLIC_CFO_COUNTY", from) ?? "Orange County";
  return {
    registrationNumber,
    county,
    statement: HOME_KITCHEN_STATEMENT,
    acknowledgement: CONSENT_ACKNOWLEDGEMENT,
    disclosureVersion: DISCLOSURE_VERSION,
    complete: registrationNumber !== null && county !== null,
  };
}

/**
 * The same gate `storeOpen` applies in `src/config/site.ts`, restated here
 * for the server: the flag alone is not enough, because a store that is open
 * without a registration number is advertising a number that does not exist.
 *
 * A function must check this itself. The build gate protects the pages, and
 * a function is not a page: it answers whoever calls it.
 */
export function storeIsOpen(from: Env = source()): boolean {
  return envBool("PUBLIC_STORE_OPEN", from) && complianceConfig(from).complete;
}

/* ------------------------------------------------------------------ */
/* Stripe                                                              */
/* ------------------------------------------------------------------ */

export interface StripeSecrets {
  readonly secretKey: string | null;
  readonly webhookSecret: string | null;
}

export function stripeSecrets(from: Env = source()): StripeSecrets {
  return {
    secretKey: env("STRIPE_SECRET_KEY", from),
    webhookSecret: env("STRIPE_WEBHOOK_SECRET", from),
  };
}

/* ------------------------------------------------------------------ */
/* Shop settings                                                       */
/* ------------------------------------------------------------------ */

/*
  TAX CODES, AND WHY THEY ARE CONFIGURATION

  Stripe Tax needs a tax category per line so that it can decide whether
  California charges tax on it. Food sold for consumption off the premises is
  generally not taxed in California and prepared food generally is, and which
  side a tray of gata falls on is a question for whoever files the return,
  not for a web developer.

  So the code is an environment variable with a documented default rather
  than a literal buried in a function. Confirm the value against Stripe's
  published tax category list, and against the CDTFA guidance, before the
  store opens. docs/LAUNCH.md is the place to record the answer.
*/
export const DEFAULT_FOOD_TAX_CODE = "txcd_40060003";
export const DEFAULT_SHIPPING_TAX_CODE = "txcd_92010001";

export interface ShopSettings {
  readonly siteUrl: string;
  readonly currency: string;
  readonly timeZone: string;
  readonly contactEmail: string;
  readonly adminEmail: string;
  readonly foodTaxCode: string;
  readonly shippingTaxCode: string;
  /** Class A annual gross sales ceiling, in cents. */
  readonly annualCapCents: number;
  /** Most lines one order may carry. A cart, not a wholesale sheet. */
  readonly maxLinesPerOrder: number;
  /** Most units of one variant in a single line. */
  readonly maxQtyPerLine: number;
  /**
   * How long a checkout session, and the capacity hold behind it, stays
   * alive. Stripe's minimum is 30 minutes.
   */
  readonly sessionTtlMinutes: number;
}

export function shopSettings(from: Env = source()): ShopSettings {
  const contactEmail = env("PUBLIC_CONTACT_EMAIL", from) ?? "hello@hakopsbakery.com";
  return {
    siteUrl: (env("PUBLIC_SITE_URL", from) ?? "https://hakopsbakery.com").replace(/\/+$/, ""),
    currency: (env("STRIPE_CURRENCY", from) ?? "usd").toLowerCase(),
    timeZone: env("SHOP_TIME_ZONE", from) ?? "America/Los_Angeles",
    contactEmail,
    adminEmail: env("ORDER_EMAIL_ADMIN", from) ?? contactEmail,
    foodTaxCode: env("STRIPE_FOOD_TAX_CODE", from) ?? DEFAULT_FOOD_TAX_CODE,
    shippingTaxCode: env("STRIPE_SHIPPING_TAX_CODE", from) ?? DEFAULT_SHIPPING_TAX_CODE,
    annualCapCents: envInt("CFO_ANNUAL_CAP_CENTS", 8_600_000, from),
    maxLinesPerOrder: envInt("ORDER_MAX_LINES", 12, from),
    maxQtyPerLine: envInt("ORDER_MAX_QTY_PER_LINE", 20, from),
    sessionTtlMinutes: Math.max(30, envInt("CHECKOUT_SESSION_TTL_MINUTES", 30, from)),
  };
}

/* ------------------------------------------------------------------ */
/* Fulfillment                                                         */
/* ------------------------------------------------------------------ */

/**
 * Fees, minimums and the delivery ZIP list, read server side.
 *
 * The browser computes the same numbers to show a customer what they will
 * pay. This is the copy that decides. Section 8 of docs/ARCHITECTURE.md: the
 * browser is never the authority on a price or on delivery eligibility.
 */
export function fulfillmentConfigFromEnv(from: Env = source()): FulfillmentConfig {
  const defaults = DEFAULT_FULFILLMENT_CONFIG;
  const zips = envList("DELIVERY_ZIPS", from) ?? defaults.delivery.zips;
  return {
    pickup: {
      available: env("PICKUP_AVAILABLE", from) === null ? defaults.pickup.available : envBool("PICKUP_AVAILABLE", from),
      feeCents: envInt("PICKUP_FEE_CENTS", defaults.pickup.feeCents, from),
      minimumOrderCents: envInt("PICKUP_MINIMUM_CENTS", defaults.pickup.minimumOrderCents, from),
    },
    delivery: {
      available:
        env("DELIVERY_AVAILABLE", from) === null ? defaults.delivery.available : envBool("DELIVERY_AVAILABLE", from),
      feeCents: envInt("DELIVERY_FEE_CENTS", defaults.delivery.feeCents, from),
      minimumOrderCents: envInt("DELIVERY_MINIMUM_CENTS", defaults.delivery.minimumOrderCents, from),
      zips,
    },
    shipping: {
      available:
        env("SHIPPING_AVAILABLE", from) === null ? defaults.shipping.available : envBool("SHIPPING_AVAILABLE", from),
      feeCents: envInt("SHIPPING_FEE_CENTS", defaults.shipping.feeCents, from),
      minimumOrderCents: envInt("SHIPPING_MINIMUM_CENTS", defaults.shipping.minimumOrderCents, from),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The bake schedule                                                   */
/* ------------------------------------------------------------------ */

/**
 * Batches per weekday, as "0:2,1:2,3:2,4:3,5:3,6:4". Sunday is 0. A weekday
 * that is absent is not a bake day, and Tuesday is refused by the schedule
 * module whatever this says, because Hakop has class.
 */
function batchesByWeekdayFromEnv(from: Env): Readonly<Partial<Record<Weekday, number>>> {
  const raw = env("BAKE_BATCHES_BY_WEEKDAY", from);
  if (raw === null) return {};
  const out: Partial<Record<Weekday, number>> = {};
  for (const pair of raw.split(",")) {
    const [left, right] = pair.split(":");
    if (left === undefined || right === undefined) continue;
    const weekday = Number.parseInt(left.trim(), 10);
    const batches = Number.parseInt(right.trim(), 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isFinite(batches) || batches < 0) continue;
    out[weekday as Weekday] = batches;
  }
  return out;
}

function dateOverridesFromEnv(from: Env): Readonly<Record<string, number>> {
  const raw = env("BAKE_DATE_OVERRIDES", from);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [date, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCalendarDate(date)) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      out[date] = Math.floor(value);
    }
    return out;
  } catch {
    /*
      A malformed override list must not take availability down. Falling back
      to the weekly pattern offers fewer dates than intended at worst, and
      the warning below is what tells Hakop to fix it.
    */
    console.warn(
      JSON.stringify({ level: "warn", event: "bake.date-overrides.malformed" }),
    );
    return {};
  }
}

/**
 * The live bake schedule configuration.
 *
 * `piecesPerBatch` has no default on purpose. It is a real number from a real
 * kitchen and nobody has counted it yet, so it is null until Hakop sets it.
 * Everything that needs capacity refuses loudly rather than inventing one.
 */
export function bakeScheduleConfigFromEnv(from: Env = source()): BakeScheduleConfig | null {
  const piecesPerBatch = envInt("BAKE_PIECES_PER_BATCH", 0, from);
  if (!Number.isFinite(piecesPerBatch) || piecesPerBatch <= 0) return null;

  return {
    timeZone: env("SHOP_TIME_ZONE", from) ?? "America/Los_Angeles",
    availability: { batchesByWeekday: batchesByWeekdayFromEnv(from) },
    cutoff: {
      hour: envInt("ORDER_CUTOFF_HOUR", 20, from),
      minute: envInt("ORDER_CUTOFF_MINUTE", 0, from),
      daysBefore: envInt("ORDER_CUTOFF_DAYS_BEFORE", 2, from),
    },
    piecesPerBatch,
    blackoutDates: (envList("BAKE_BLACKOUT_DATES", from) ?? []).filter(isCalendarDate),
    dateOverrides: dateOverridesFromEnv(from),
    horizonDays: envInt("BAKE_HORIZON_DAYS", 28, from),
  };
}
