/**
 * The server calls the islands make, and the shapes both sides agree on.
 *
 * The public site is static HTML. These four endpoints are the only moments
 * it talks to a server, so the contract is written down once, here, rather
 * than as a fetch call improvised inside each island.
 *
 * THESE TYPES MIRROR netlify/functions. They are hand written rather than
 * imported, because a function module pulls in zod, the Netlify types and
 * the server configuration loader, none of which belong in a browser bundle.
 * The price of that is drift, and the guard against it is that every one of
 * these shapes is a copy of a response literal in the function named above
 * it. If you change a function, change the interface here in the same
 * sitting.
 *
 * Two rules govern every request in this file.
 *
 *   1. A price is never sent. A request carries a sku, a variant id and a
 *      quantity. The function resolves the money from the same catalog the
 *      site was built from, and strips anything that looks like a price out
 *      of the request before it starts. Section 4 of docs/ARCHITECTURE.md.
 *   2. Availability is never cached. A sold out bake date has to be sold out
 *      in the picker, not a surprise at payment, so every read goes out with
 *      no-store.
 */

import type { CartLine } from "@lib/cart";
import type { FulfillmentDenialReason, FulfillmentMode } from "@lib/zones";
import type { BakeDateStatus, IsoDate, Weekday } from "@lib/bake-schedule";
import type { ZipRejectionReason } from "@lib/california";

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

/**
 * Each function declares its own `config.path`, so these are the real
 * addresses rather than the /.netlify/functions/ default. They are on the
 * same origin, which is why the Content Security Policy in netlify.toml can
 * keep connect-src at 'self'.
 *
 * Every island takes its endpoint as a prop, so a page, a test or a preview
 * can point one somewhere else without editing this file.
 */
export const ENDPOINTS = {
  deliveryZone: "/api/check-delivery-zone",
  availability: "/api/check-availability",
  checkout: "/api/create-checkout-session",
  subscribe: "/api/subscribe",
} as const;

/* ------------------------------------------------------------------ */
/* check-delivery-zone                                                 */
/* ------------------------------------------------------------------ */

/**
 * The California gate, first of the three places it is enforced.
 *
 * The function answers 200 for any well formed request: a ZIP in Nevada is
 * an answer, not an error, and the caller reads `inCalifornia` rather than
 * the status code. It resolves all three modes at once so the picker can
 * refuse delivery and offer shipping in the same breath.
 *
 * A subtotal may be sent, and this site does not send one. The minimum that
 * decides anything is checked at checkout against a subtotal the server
 * worked out from the catalog, and a browser that sends money is a browser
 * that has to be distrusted.
 */
export interface ZoneRequest {
  readonly zip: string;
  readonly mode: FulfillmentMode;
}

export interface ZoneModeAnswer {
  readonly mode: FulfillmentMode;
  readonly available: boolean;
  readonly feeCents: number | null;
  readonly minimumOrderCents: number | null;
  readonly reason: FulfillmentDenialReason | null;
  /** Plain language, written by `src/lib/zones.ts`. Ready to show. */
  readonly message: string | null;
  readonly shortfallCents: number | null;
}

export interface ZoneResponse {
  readonly ok: true;
  /** Normalized five digits, or null when the ZIP was not a California one. */
  readonly zip: string | null;
  readonly inCalifornia: boolean;
  readonly reason: ZipRejectionReason | null;
  readonly modes: readonly ZoneModeAnswer[];
  readonly requestedMode: FulfillmentMode | null;
  readonly sellsOnlyInCalifornia: boolean;
}

/* ------------------------------------------------------------------ */
/* check-availability                                                  */
/* ------------------------------------------------------------------ */

export interface AvailabilityDate {
  readonly date: IsoDate;
  readonly weekday: Weekday;
  readonly status: BakeDateStatus;
  /** True only when the date is open. The one field a picker needs. */
  readonly selectable: boolean;
  /** The instant ordering closes, ISO 8601. Format it in `timeZone`. */
  readonly cutoffAt: string;
  /** What is left. The ceiling itself stays on the server. */
  readonly remainingPieces: number;
}

export interface AvailabilityResponse {
  readonly ok: true;
  readonly timeZone: string;
  readonly today: IsoDate;
  /** When this answer was computed, so a stale one is visible. */
  readonly generatedAt: string;
  /** Sold out, blacked out and closed dates are included, not filtered. */
  readonly dates: readonly AvailabilityDate[];
  readonly nextOpen: IsoDate | null;
}

/**
 * A pickup window.
 *
 * check-availability does not return these yet, because Hakop has not set
 * his pickup times. The shape is here, and FulfillmentPicker takes the list
 * as a prop, so the day it becomes configuration there is one place to wire
 * it in and nothing else changes.
 */
export interface PickupSlot {
  readonly id: string;
  /** Customer facing and already formatted. "4pm to 6pm". */
  readonly label: string;
  readonly soldOut: boolean;
}

/* ------------------------------------------------------------------ */
/* create-checkout-session                                             */
/* ------------------------------------------------------------------ */

/**
 * What the customer agreed to.
 *
 * The wording version matters as much as the tick. If the county ever asks
 * for different disclosure wording, `compliance.disclosureVersion` is bumped
 * and every consent already recorded still names the wording that was
 * actually on screen. A request carrying a stale version is refused with
 * `consent-version-stale` rather than quietly accepted.
 */
export interface CheckoutConsent {
  readonly accepted: boolean;
  /** compliance.disclosureVersion, passed in to the island by the page. */
  readonly version: string;
}

export interface CheckoutRequest {
  readonly lines: readonly CartLine[];
  readonly fulfillment: {
    readonly mode: FulfillmentMode;
    readonly zip: string | null;
    readonly bakeDate: IsoDate;
    readonly slotId: string | null;
  };
  readonly consent: CheckoutConsent;
  /**
   * One id per checkout attempt, generated in the browser and kept across a
   * retry. The server folds it into the fingerprint that produces the hold
   * and the Stripe idempotency key, so a double tap on a slow connection
   * cannot claim capacity twice or open two payment pages.
   */
  readonly requestId: string;
}

export interface CheckoutResponse {
  readonly ok: true;
  readonly sessionId: string;
  /** Stripe Checkout. Send the browser here and nowhere else. */
  readonly url: string;
  /** The order reference. Issued by the server, never by the browser. */
  readonly orderRef: string;
  readonly bakeDate: IsoDate;
  /** When the capacity hold expires if payment is not completed. */
  readonly expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* subscribe                                                           */
/* ------------------------------------------------------------------ */

export interface SubscribeRequest {
  readonly email: string;
  /** Must be true. The function refuses `consent-required` otherwise. */
  readonly consent: boolean;
  readonly source: string;
  /** Honeypot. A filled value is a robot. Always sent, always empty. */
  readonly website: string;
}

export interface SubscribeResponse {
  readonly ok: true;
  readonly status: "subscribed";
  readonly message: string;
  readonly consent?: {
    readonly text?: string;
    readonly version?: string;
    readonly at?: string;
    readonly usedFor?: string;
    readonly notUsedFor?: string;
    readonly unsubscribe?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Failure                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every refusal is `{ ok: false, error: { code, message, ...extra } }` with a
 * real HTTP status. The islands branch on a handful of these codes and show
 * the server's own sentence for all the rest, because the function knows
 * more about what went wrong than a switch statement in a browser does.
 *
 * Codes that change an island's behaviour rather than only its wording:
 *
 *   out-of-state, outside-delivery-area, zip-malformed, zip-missing,
 *   below-minimum, mode-unavailable      the ZIP is no longer confirmed
 *   bake-date-sold-out, bake-date-past-cutoff, bake-date-blackout,
 *   bake-date-unavailable, bake-date-too-soon, bake-date-invalid
 *                                        the chosen day is cleared
 *   consent-version-stale                the page itself is out of date
 *   store-closed                         ordering is not open after all
 *   rate-limited                         wait, then retry
 */
export interface ApiFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Some refusals carry more: reference, currentVersion, status, date. */
    readonly [key: string]: unknown;
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/** Long enough for a cold function, short enough that nobody stares. */
const DEFAULT_TIMEOUT_MS = 12_000;

/** Why a request failed, when it failed before the server had an opinion. */
export type TransportCode = "timeout" | "network" | "server" | "bad-response" | "aborted";

export class EndpointError extends Error {
  readonly code: TransportCode | string;
  readonly status: number | null;
  /** The rest of the error body, for the refusals that carry more. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TransportCode | string,
    message: string,
    status: number | null = null,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "EndpointError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** A string field of the error body, when the server sent one. */
  detail(key: string): string | null {
    const value = this.details[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * One fetch, with a timeout, and with every failure turned into an
 * EndpointError carrying a code an island can act on.
 *
 * A hung request is the worst of the failure modes, because nothing on
 * screen changes and the customer cannot tell whether it is working. The
 * timeout is not optional and it is deliberately shorter than a browser's.
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { method = "POST", body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      /* A live answer, or no answer. Never a cached one. */
      cache: "no-store",
      credentials: "same-origin",
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      throw new EndpointError("timeout", "The request took too long to answer.");
    }
    if (signal?.aborted) {
      /* The island unmounted or moved on. Nothing to show anybody. */
      throw new EndpointError("aborted", "The request was cancelled.");
    }
    throw new EndpointError("network", "The connection dropped before we got an answer.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EndpointError(
        "bad-response",
        "The server answered with something we could not read.",
        response.status,
      );
    }
  }

  if (!response.ok) {
    const failure = parsed as Partial<ApiFailure> | null;
    const error = failure?.error;
    const { code, message, ...rest } = error ?? {};
    throw new EndpointError(
      typeof code === "string" ? code : "server",
      typeof message === "string" && message.length > 0
        ? message
        : "The server could not complete that request.",
      response.status,
      rest,
    );
  }

  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* Copy for a failure                                                  */
/* ------------------------------------------------------------------ */

const TRANSPORT_COPY: Readonly<Record<string, string>> = {
  timeout: "That is taking longer than it should. The connection may be slow.",
  network: "We could not reach the bakery. Check your connection and try again.",
  "bad-response": "Something answered, but not with an answer we understand.",
  server: "Something went wrong at our end, not at yours.",
};

/**
 * A sentence to put in front of a customer.
 *
 * A refusal from a function already carries the function's own wording, and
 * that wording wins: `zones.ts` and `california.ts` own the sentences about
 * eligibility, and nothing here should invent a second version of them.
 */
export function friendlyError(cause: unknown): string {
  if (cause instanceof EndpointError) {
    return TRANSPORT_COPY[cause.code] ?? cause.message;
  }
  return "Something went wrong. Try again in a moment.";
}

/** True when trying the same request again is a reasonable suggestion. */
export function isRetryable(cause: unknown): boolean {
  if (!(cause instanceof EndpointError)) return true;
  if (cause.code === "rate-limited") return true;
  return (
    cause.code === "timeout" ||
    cause.code === "network" ||
    cause.code === "server" ||
    cause.code === "bad-response" ||
    (cause.status !== null && cause.status >= 500)
  );
}
