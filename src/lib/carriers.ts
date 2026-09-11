/**
 * Carriers, transit times, and what can actually be shipped where.
 *
 * This module answers one question: given a destination address, a parcel,
 * and a bake date, which carrier services can legally and practically deliver
 * it, and on what day does it arrive?
 *
 * Pure logic. No DOM, no network, no environment reads. It runs in the
 * browser, in a Netlify function, and at build time, and it is the same code
 * in all three so the customer is never told one thing in the cart and a
 * different thing at checkout.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * "Ship it" is not one rule, it is four that interact:
 *
 *   1. The state line.  Cottage food may only be sold inside California.
 *   2. The address form.  UPS and FedEx physically cannot deliver to a PO Box
 *      or to an APO, FPO or DPO address. USPS can. That is not a preference,
 *      it is the network.
 *   3. The calendar.  Ground services do not move on Sundays or on federal
 *      holidays, and most do not move on Saturdays either. A parcel handed
 *      over on a Friday can sit in a building until Monday.
 *   4. Freshness.  This is a bakery. A box that arrives technically on time
 *      but past its best by date is a refund and a lost customer, and no
 *      carrier will tell you that you got it wrong.
 *
 * Rule 4 is the one nobody builds and it is the one that matters most here.
 *
 * ---------------------------------------------------------------------------
 * ONE PIECE OF LUCK WORTH KNOWING
 *
 * Cottage food law forbids anything that needs refrigeration: no cream
 * fillings, no custards, no cheesecake, nothing acidified. Which means
 * everything Hakop is legally allowed to sell is, by definition, shelf
 * stable. Shelf stable baked goods are ordinary parcels to all three
 * carriers. No permit, no dry ice, no special handling, no perishable
 * surcharge, no cold chain.
 *
 * The legal constraint and the shipping constraint happen to point the same
 * way. That is why this can stay simple.
 */

import { isCaliforniaZip, normalizeZip } from "./california";

/* ==================================================================== */
/* Destination addresses                                                */
/* ==================================================================== */

/**
 * The shape of an address as Stripe hands it back on a completed session.
 * Deliberately matches Stripe's field names so the webhook can pass it
 * straight through without a translation layer that could introduce a bug in
 * the one place a bug is expensive.
 */
export interface DestinationAddress {
  readonly line1: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  /** Two letter code. This is the authoritative field. See the note below. */
  readonly state: string | null;
  readonly postal_code: string | null;
  readonly country?: string | null;
}

export const ADDRESS_FORMS = ["street", "po-box", "military"] as const;
export type AddressForm = (typeof ADDRESS_FORMS)[number];

/**
 * PO Box, in the many ways people write it.
 *
 * Matches "PO Box 12", "P.O. Box 12", "POB 12", "Post Office Box 12" and
 * "Postal Box 12", anchored so that a street genuinely called something like
 * "Post Road" or a business named "The Box Company" does not trip it.
 *
 * Deliberately does NOT match "PMB" (private mailbox) or a Mailboxes Etc
 * style suite number. Those are commercial street addresses that UPS and
 * FedEx deliver to perfectly well.
 */
const PO_BOX = /(?:^|\b)(?:p\.?\s*o\.?\s*box|post(?:al)?\s+office\s+box|postal\s+box|p\.?\s*o\.?\s*b\.?)\s*#?\s*\d/i;

/** Armed Forces: Americas, Europe, Pacific. USPS territory only. */
const MILITARY_STATES = new Set(["AA", "AE", "AP"]);

/**
 * Military ZIP blocks. AE is 090xx to 098xx, AA is 340xx, AP is 962xx to
 * 966xx. Note that AP sits just above California's ceiling of 96162 and does
 * not overlap it, which is worth stating out loud because the two look
 * adjacent and a future edit could easily widen the California range into
 * military space.
 */
function isMilitaryZip(zip: string): boolean {
  const n = Number.parseInt(zip, 10);
  if (!Number.isFinite(n)) return false;
  return (n >= 9_000 && n <= 9_899) || (n >= 34_000 && n <= 34_099) || (n >= 96_200 && n <= 96_699);
}

/**
 * What kind of address is this?
 *
 * The answer decides which carriers are even possible, so it is worked out
 * once and passed around rather than re-derived with a slightly different
 * regular expression in three places.
 */
export function detectAddressForm(address: Pick<DestinationAddress, "line1" | "line2" | "state" | "postal_code">): AddressForm {
  const state = (address.state ?? "").trim().toUpperCase();
  const zip = normalizeZip(address.postal_code) ?? "";

  if (MILITARY_STATES.has(state) || isMilitaryZip(zip)) return "military";

  const lines = `${address.line1 ?? ""} ${address.line2 ?? ""}`;
  if (PO_BOX.test(lines)) return "po-box";

  return "street";
}

/* ==================================================================== */
/* The state gate                                                       */
/* ==================================================================== */

export const DESTINATION_REJECTIONS = [
  "missing-address",
  "not-us",
  "military",
  "state-not-california",
  "zip-not-california",
  "state-zip-mismatch",
] as const;

export type DestinationRejection = (typeof DESTINATION_REJECTIONS)[number];

export type DestinationCheck =
  | { readonly ok: true; readonly zip: string; readonly form: AddressForm }
  | { readonly ok: false; readonly reason: DestinationRejection; readonly message: string };

const DESTINATION_MESSAGES: Readonly<Record<DestinationRejection, string>> = {
  "missing-address": "We did not receive a complete delivery address.",
  "not-us":
    "We can only ship inside the United States, and inside California only.",
  military:
    "We cannot ship to APO, FPO or DPO addresses. California cottage food " +
    "law limits sales to addresses inside the state, and military mail is " +
    "handled outside it.",
  "state-not-california":
    "That address is outside California. A home kitchen operation can only " +
    "sell inside the state.",
  "zip-not-california":
    "That ZIP code is outside California. A home kitchen operation can only " +
    "sell inside the state.",
  "state-zip-mismatch":
    "The state and the ZIP code on that address do not match. Please check " +
    "the address and try again.",
};

/**
 * THE LEGAL GATE. Run this on the final address, server side, after payment.
 *
 * ---------------------------------------------------------------------------
 * THE ZIP IS FOR THE CUSTOMER. THE STATE FIELD IS FOR THE LAW.
 *
 * Everywhere else in this codebase a ZIP is checked, because a ZIP is what a
 * customer types into a box in the cart before an address exists, and it is
 * a friendly early answer.
 *
 * This function is different. By the time it runs, Stripe has collected a
 * complete structured address with a real two letter state code, which is an
 * authoritative field rather than something inferred from a number. So the
 * state is checked first and the ZIP is checked as corroboration. If the two
 * disagree the address is refused rather than guessed at, because a mismatch
 * means either a typo or someone probing the gate, and neither should be
 * fulfilled.
 *
 * This is the check the brief says gets skipped. It is the only one a
 * customer cannot get around, because it runs after they have stopped being
 * able to edit anything.
 */
export function checkCaliforniaDestination(address: DestinationAddress | null | undefined): DestinationCheck {
  const fail = (reason: DestinationRejection): DestinationCheck => ({
    ok: false,
    reason,
    message: DESTINATION_MESSAGES[reason],
  });

  if (!address || !address.line1 || !address.postal_code) return fail("missing-address");

  const country = (address.country ?? "US").trim().toUpperCase();
  if (country !== "US" && country !== "USA") return fail("not-us");

  const form = detectAddressForm(address);
  if (form === "military") return fail("military");

  const state = (address.state ?? "").trim().toUpperCase();
  if (state !== "CA") return fail("state-not-california");

  const zipResult = isCaliforniaZip(address.postal_code);
  if (!zipResult.ok) {
    // The state says California and the ZIP does not. Refuse rather than
    // pick a winner. Two fields disagreeing is not a thing to resolve
    // quietly on an order that has already been paid for.
    return fail(zipResult.reason === "out-of-state" ? "state-zip-mismatch" : "zip-not-california");
  }

  return { ok: true, zip: zipResult.zip, form };
}

/* ==================================================================== */
/* Carrier services                                                     */
/* ==================================================================== */

export const CARRIERS = ["usps", "ups", "fedex"] as const;
export type Carrier = (typeof CARRIERS)[number];

export const CARRIER_LABELS: Readonly<Record<Carrier, string>> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
};

export type ServiceCode =
  | "usps_ground_advantage"
  | "usps_priority"
  | "ups_ground"
  | "fedex_home_delivery"
  | "fedex_ground";

export interface ServiceSpec {
  readonly code: ServiceCode;
  readonly carrier: Carrier;
  readonly label: string;
  /** Business days in transit, within California, best and worst case. */
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  /** Which weekdays this service actually delivers on. 0 is Sunday. */
  readonly deliversOn: readonly number[];
  /** Can this service reach a PO Box? Only USPS can. */
  readonly acceptsPoBox: boolean;
  /** Can this service reach APO, FPO or DPO? Only USPS can, and we refuse
   *  those anyway on state grounds, so this exists for completeness. */
  readonly acceptsMilitary: boolean;
  /** Maximum parcel weight, in ounces. */
  readonly maxWeightOz: number;
  /** Home Delivery goes to residences, Ground goes to businesses. */
  readonly destination: "any" | "residential" | "commercial";
}

/**
 * The service catalogue.
 *
 * Transit figures are for shipments that start and finish inside California,
 * which is the only kind this business makes. Coast to coast numbers would be
 * longer and are deliberately not modelled, because a shipment that needs
 * them is a shipment that is already illegal.
 *
 * These are published service commitments, not guarantees, and none of these
 * three carriers guarantees a ground delivery date. Treat every arrival date
 * this module produces as an estimate and say so to the customer.
 */
export const SERVICES: Readonly<Record<ServiceCode, ServiceSpec>> = {
  usps_ground_advantage: {
    code: "usps_ground_advantage",
    carrier: "usps",
    label: "USPS Ground Advantage",
    transitDaysMin: 2,
    transitDaysMax: 3,
    deliversOn: [1, 2, 3, 4, 5, 6], // Monday to Saturday
    acceptsPoBox: true,
    acceptsMilitary: true,
    maxWeightOz: 70 * 16,
    destination: "any",
  },
  usps_priority: {
    code: "usps_priority",
    carrier: "usps",
    label: "USPS Priority Mail",
    transitDaysMin: 1,
    transitDaysMax: 2,
    deliversOn: [1, 2, 3, 4, 5, 6],
    acceptsPoBox: true,
    acceptsMilitary: true,
    maxWeightOz: 70 * 16,
    destination: "any",
  },
  ups_ground: {
    code: "ups_ground",
    carrier: "ups",
    label: "UPS Ground",
    transitDaysMin: 1,
    transitDaysMax: 2,
    // UPS has added Saturday Ground delivery in some markets. Modelled
    // conservatively as Monday to Friday, because promising a Saturday that
    // does not happen is worse than not promising it.
    deliversOn: [1, 2, 3, 4, 5],
    acceptsPoBox: false,
    acceptsMilitary: false,
    maxWeightOz: 150 * 16,
    destination: "any",
  },
  fedex_home_delivery: {
    code: "fedex_home_delivery",
    carrier: "fedex",
    label: "FedEx Home Delivery",
    transitDaysMin: 1,
    transitDaysMax: 2,
    deliversOn: [2, 3, 4, 5, 6], // Tuesday to Saturday, residential
    acceptsPoBox: false,
    acceptsMilitary: false,
    maxWeightOz: 150 * 16,
    destination: "residential",
  },
  fedex_ground: {
    code: "fedex_ground",
    carrier: "fedex",
    label: "FedEx Ground",
    transitDaysMin: 1,
    transitDaysMax: 2,
    deliversOn: [1, 2, 3, 4, 5], // Monday to Friday, commercial
    acceptsPoBox: false,
    acceptsMilitary: false,
    maxWeightOz: 150 * 16,
    destination: "commercial",
  },
};

/* ==================================================================== */
/* Calendar                                                             */
/* ==================================================================== */

/**
 * Federal holidays. No carrier moves ground freight on these.
 *
 * Listed explicitly rather than computed, because the observed date of a
 * holiday that lands on a weekend is a rule about rules and getting it
 * subtly wrong would quietly promise a delivery that cannot happen. Extend
 * this list every year. scripts/preflight.mjs warns when it runs short.
 */
export const FEDERAL_HOLIDAYS: readonly string[] = [
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Presidents Day
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day, observed. The 4th is a Saturday.
  "2026-09-07", // Labor Day
  "2026-10-12", // Columbus Day
  "2026-11-11", // Veterans Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-05-31",
  "2027-06-18", // Juneteenth, observed. The 19th is a Saturday.
  "2027-07-05", // Independence Day, observed. The 4th is a Sunday.
  "2027-09-06",
  "2027-10-11",
  "2027-11-11",
  "2027-11-25",
  "2027-12-24", // Christmas, observed. The 25th is a Saturday.
];

const HOLIDAY_SET = new Set(FEDERAL_HOLIDAYS);

/**
 * Calendar dates are handled as plain "YYYY-MM-DD" strings and anchored at
 * midday UTC whenever a Date is genuinely needed.
 *
 * Midday, not midnight, on purpose. Anchoring at midnight means a timezone
 * offset of a few hours can roll a date onto the previous or next day, which
 * is exactly the class of bug that makes a bakery promise a Tuesday delivery
 * and bake on Wednesday. Midday leaves twelve hours of slack in both
 * directions, which is more than any real offset.
 */
function toUtcNoon(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 0 is Sunday, 6 is Saturday. */
export function weekdayOf(isoDate: string): number {
  return toUtcNoon(isoDate).getUTCDay();
}

export function addDays(isoDate: string, days: number): string {
  const d = toUtcNoon(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function isHoliday(isoDate: string): boolean {
  return HOLIDAY_SET.has(isoDate);
}

/** A day carriers actually move freight: Monday to Friday, not a holiday. */
export function isTransitDay(isoDate: string): boolean {
  const day = weekdayOf(isoDate);
  return day >= 1 && day <= 5 && !isHoliday(isoDate);
}

/**
 * Walk forward n transit days from a ship date, then keep walking until a day
 * the chosen service actually delivers on.
 *
 * Two separate calendars, and conflating them is the classic bug. Freight
 * moves Monday to Friday. Delivery happens on the days that service runs,
 * which for FedEx Home Delivery includes Saturday and excludes Monday. A
 * parcel can be sitting on a truck on a day nobody will hand it over.
 */
export function arrivalDate(shipDate: string, service: ServiceSpec, transitDays: number): string {
  let cursor = shipDate;
  let moved = 0;

  while (moved < transitDays) {
    cursor = addDays(cursor, 1);
    if (isTransitDay(cursor)) moved += 1;
  }

  // It has arrived in the area. Now wait for a day this service delivers.
  let guard = 0;
  while ((!service.deliversOn.includes(weekdayOf(cursor)) || isHoliday(cursor)) && guard < 14) {
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  return cursor;
}

/* ==================================================================== */
/* Quoting                                                              */
/* ==================================================================== */

export interface ParcelSpec {
  readonly weightOz: number;
  /** Residential unless we know otherwise. Most customers are homes. */
  readonly destinationType?: "residential" | "commercial";
}

export interface FreshnessPolicy {
  /**
   * How many days the product is genuinely good for after it is baked. From
   * the product record, never from a recipe. This is a shelf life, not a
   * method.
   */
  readonly bestByDays: number;
  /**
   * Days of headroom demanded between arrival and the best by date, so a box
   * does not land on its last good morning. One day is thin. Two is kind.
   */
  readonly marginDays: number;
}

export interface ShippingQuote {
  readonly service: ServiceSpec;
  readonly shipDate: string;
  /** Best case and worst case arrival, because ground is never guaranteed. */
  readonly arrivalEarliest: string;
  readonly arrivalLatest: string;
  /** Days between baking and the worst case arrival. */
  readonly daysInTransitWorstCase: number;
  readonly freshOnArrival: boolean;
}

export const QUOTE_REJECTIONS = [
  "po-box-needs-usps",
  "military-not-served",
  "too-heavy",
  "wrong-destination-type",
  "arrives-stale",
] as const;

export type QuoteRejection = (typeof QUOTE_REJECTIONS)[number];

export interface RejectedService {
  readonly service: ServiceSpec;
  readonly reason: QuoteRejection;
  readonly message: string;
}

export interface QuoteResult {
  readonly offered: readonly ShippingQuote[];
  readonly rejected: readonly RejectedService[];
}

/**
 * Choose the day a parcel is handed to the carrier.
 *
 * Baked on day zero, packed and handed over on the next day the carrier is
 * actually collecting. Never the same day: the tray has to cool, be packed,
 * and be labelled, and a carrier pickup window does not wait for an oven.
 */
export function shipDateFor(bakeDate: string): string {
  let cursor = addDays(bakeDate, 1);
  let guard = 0;
  while (!isTransitDay(cursor) && guard < 14) {
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return cursor;
}

/**
 * Which services can carry this parcel to this address, and when does it land?
 *
 * Returns both what is offered and what was refused and why. The refusals are
 * not noise: when a customer enters a PO Box and only USPS comes back, the
 * page should be able to say so plainly rather than silently showing one
 * option and letting them wonder where UPS went.
 */
export function quoteShipping(input: {
  readonly address: DestinationAddress;
  readonly parcel: ParcelSpec;
  readonly bakeDate: string;
  readonly freshness: FreshnessPolicy;
  /** Restrict to a subset, for example if Hakop only has USPS set up yet. */
  readonly enabledServices?: readonly ServiceCode[];
}): QuoteResult {
  const { address, parcel, bakeDate, freshness } = input;

  const form = detectAddressForm(address);
  const destinationType = parcel.destinationType ?? "residential";
  const shipDate = shipDateFor(bakeDate);

  const codes = input.enabledServices ?? (Object.keys(SERVICES) as ServiceCode[]);

  const offered: ShippingQuote[] = [];
  const rejected: RejectedService[] = [];

  for (const code of codes) {
    const service = SERVICES[code];
    if (!service) continue;

    if (form === "po-box" && !service.acceptsPoBox) {
      rejected.push({
        service,
        reason: "po-box-needs-usps",
        message: `${CARRIER_LABELS[service.carrier]} does not deliver to PO Boxes. USPS does.`,
      });
      continue;
    }

    if (form === "military" && !service.acceptsMilitary) {
      rejected.push({
        service,
        reason: "military-not-served",
        message: `${CARRIER_LABELS[service.carrier]} does not serve APO, FPO or DPO addresses.`,
      });
      continue;
    }

    if (parcel.weightOz > service.maxWeightOz) {
      rejected.push({
        service,
        reason: "too-heavy",
        message: `That parcel is over the ${service.label} weight limit.`,
      });
      continue;
    }

    if (service.destination !== "any" && service.destination !== destinationType) {
      rejected.push({
        service,
        reason: "wrong-destination-type",
        message:
          service.destination === "residential"
            ? `${service.label} delivers to homes, not business addresses.`
            : `${service.label} delivers to business addresses, not homes.`,
      });
      continue;
    }

    const arrivalEarliest = arrivalDate(shipDate, service, service.transitDaysMin);
    const arrivalLatest = arrivalDate(shipDate, service, service.transitDaysMax);

    // Freshness is measured from the bake date, not the ship date. The clock
    // starts when it comes out of the oven, not when the carrier collects it.
    const daysInTransitWorstCase = daysBetween(bakeDate, arrivalLatest);
    const freshOnArrival = daysInTransitWorstCase + freshness.marginDays <= freshness.bestByDays;

    if (!freshOnArrival) {
      rejected.push({
        service,
        reason: "arrives-stale",
        message:
          `${service.label} would not get it there while it is still at its ` +
          `best. We would rather not send it than send it late.`,
      });
      continue;
    }

    offered.push({
      service,
      shipDate,
      arrivalEarliest,
      arrivalLatest,
      daysInTransitWorstCase,
      freshOnArrival,
    });
  }

  // Soonest worst case arrival first. A customer choosing a shipping option
  // is choosing a date, not a brand.
  offered.sort((a, b) => a.arrivalLatest.localeCompare(b.arrivalLatest));

  return { offered, rejected };
}

/** Whole calendar days between two ISO dates. */
export function daysBetween(from: string, to: string): number {
  const ms = toUtcNoon(to).getTime() - toUtcNoon(from).getTime();
  return Math.round(ms / 86_400_000);
}
