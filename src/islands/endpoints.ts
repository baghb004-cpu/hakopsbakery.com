/**
 * The server calls the islands are allowed to make, and the shapes both
 * sides agree on.
 *
 * The public site is static HTML. These four endpoints are the only moments
 * it talks to a server, so the contract is written down once, here, rather
 * than as a fetch call improvised inside each island.
 *
 * Two rules govern every request in this file.
 *
 *   1. A price is never sent. A request carries a sku, a variant id and a
 *      quantity. The function resolves the money from the same catalog the
 *      site was built from. Section 4 of docs/ARCHITECTURE.md.
 *   2. Availability is never cached. A sold out bake date has to be sold out
 *      in the picker, not a surprise at payment, so every availability read
 *      goes out with no-store.
 *
 * NOTE FOR WHOEVER WRITES netlify/functions: these are the shapes the islands
 * already speak. See the summary at the end of the islands work for the full
 * list, including the waitlist endpoint, which docs/ARCHITECTURE.md does not
 * yet name.
 */

import type { CartLine, Fulfillment } from "@lib/cart";
import type { FulfillmentMode, FulfillmentResult } from "@lib/zones";
import type { BakeSchedule, IsoDate } from "@lib/bake-schedule";

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

/**
 * Netlify serves functions from this prefix on the same origin, which is why
 * the Content Security Policy in netlify.toml can keep connect-src at 'self'.
 * Every island takes its endpoint as a prop so a page, a test or a preview
 * can point it somewhere else without editing this file.
 */
export const ENDPOINTS = {
  deliveryZone: "/.netlify/functions/check-delivery-zone",
  availability: "/.netlify/functions/check-availability",
  checkout: "/.netlify/functions/create-checkout-session",
  waitlist: "/.netlify/functions/join-waitlist",
} as const;

/* ------------------------------------------------------------------ */
/* check-delivery-zone                                                 */
/* ------------------------------------------------------------------ */

/**
 * The California gate, first of the three places it is enforced.
 *
 * `lines` is sent instead of a subtotal on purpose. Some modes carry a
 * minimum order, and the only honest way to judge a minimum is for the
 * server to price the cart itself from the catalog.
 */
export interface ZoneRequest {
  readonly mode: FulfillmentMode;
  /** Raw as typed. The function normalizes it. Null for pickup. */
  readonly zip: string | null;
  readonly lines: readonly CartLine[];
}

/** The function answers with the result type from `src/lib/zones.ts`. */
export type ZoneResponse = FulfillmentResult;

/* ------------------------------------------------------------------ */
/* check-availability                                                  */
/* ------------------------------------------------------------------ */

/**
 * One pickup window on one bake date. Sold out windows come back in the list
 * rather than being filtered out, for the same reason sold out dates do: a
 * window that silently disappears reads as a bug.
 */
export interface PickupSlot {
  readonly id: string;
  /** Customer facing, already formatted by the server. "4pm to 6pm". */
  readonly label: string;
  readonly soldOut: boolean;
}

export interface AvailabilityResponse {
  /** Built by `buildBakeSchedule()` server side, including unselectable dates. */
  readonly schedule: BakeSchedule;
  /** Keyed by bake date. A date with no windows posted yet is absent. */
  readonly pickupSlots: Readonly<Record<IsoDate, readonly PickupSlot[]>>;
}

/* ------------------------------------------------------------------ */
/* create-checkout-session                                             */
/* ------------------------------------------------------------------ */

/**
 * What the customer agreed to, recorded at the moment they agreed to it.
 *
 * The wording version matters as much as the timestamp. If the county ever
 * asks for different disclosure wording, `compliance.disclosureVersion` is
 * bumped and every consent already recorded still names the wording that was
 * actually on screen. See docs/COMPLIANCE.md.
 */
export interface ConsentRecord {
  /** compliance.disclosureVersion, passed in by the page. */
  readonly disclosureVersion: string;
  /** ISO 8601 instant, in UTC. */
  readonly acceptedAt: string;
  /**
   * A reference generated in the browser so the customer, the consent record
   * and the Stripe session all share one string. The server should store it
   * and may still issue its own canonical order number: this is a reference,
   * not an identity, and nothing server side should trust it to be unique.
   */
  readonly orderRef: string;
}

export interface CheckoutRequest {
  readonly lines: readonly CartLine[];
  readonly fulfillment: Fulfillment;
  readonly consent: ConsentRecord;
}

export interface CheckoutSuccess {
  readonly ok: true;
  /** The Stripe Checkout URL to send the browser to. */
  readonly url: string;
}

export type CheckoutResponse = CheckoutSuccess | ApiFailure;

/* ------------------------------------------------------------------ */
/* join-waitlist                                                       */
/* ------------------------------------------------------------------ */

export interface WaitlistRequest {
  readonly email: string;
  /** Which page they signed up from, so the list is worth something later. */
  readonly source: string;
  /** Honeypot. A filled value means a robot. Always sent, usually empty. */
  readonly company: string;
}

export type WaitlistResponse = { readonly ok: true } | ApiFailure;

/* ------------------------------------------------------------------ */
/* Failure                                                             */
/* ------------------------------------------------------------------ */

/**
 * Codes an island changes its behaviour on. Anything else is shown to the
 * customer as the server's own sentence, because the server knows more about
 * what went wrong than a switch statement in a browser does.
 */
export const API_ERROR_CODES = [
  "out-of-state",
  "outside-delivery-area",
  "zip-malformed",
  "below-minimum",
  "sold-out",
  "past-cutoff",
  "empty-cart",
  "unavailable-variant",
  "store-closed",
  "rate-limited",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiFailure {
  readonly ok: false;
  readonly error: {
    /** One of API_ERROR_CODES, or any other string the function wants. */
    readonly code: string;
    /** Plain language, ready to show. Written by the function, not guessed. */
    readonly message: string;
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/** Long enough for a cold function, short enough that nobody stares. */
const DEFAULT_TIMEOUT_MS = 12_000;

/** Why a request failed, in the words an island needs to branch on. */
export type TransportCode = "timeout" | "network" | "server" | "bad-response";

export class EndpointError extends Error {
  readonly code: TransportCode | string;
  readonly status: number | null;

  constructor(code: TransportCode | string, message: string, status: number | null = null) {
    super(message);
    this.name = "EndpointError";
    this.code = code;
    this.status = status;
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
 * A hung request is the worst of the failure modes because nothing on screen
 * changes, so the timeout is not optional and it is deliberately shorter than
 * a browser's own.
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
      /* Availability and eligibility are live answers. Never a cached one. */
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (timedOut) {
      throw new EndpointError("timeout", "The request took too long to answer.");
    }
    if (signal?.aborted) {
      /* The island unmounted or moved on. Nothing to show anybody. */
      throw new EndpointError("aborted", "The request was cancelled.");
    }
    throw new EndpointError("network", "The connection dropped before we got an answer.", null);
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
    throw new EndpointError(
      typeof error?.code === "string" ? error.code : "server",
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : "The server could not complete that request.",
      response.status,
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
  "rate-limited": "That was a lot of requests at once. Wait a moment and try again.",
};

/**
 * A sentence to put in front of a customer.
 *
 * An EndpointError raised from a function response already carries the
 * function's own wording, and that wording wins: `zones.ts` and
 * `california.ts` own the sentences about eligibility, and nothing here
 * should invent a second version of them.
 */
export function friendlyError(cause: unknown): string {
  if (cause instanceof EndpointError) {
    const known = TRANSPORT_COPY[cause.code];
    if (known) return known;
    return cause.message;
  }
  return "Something went wrong. Try again in a moment.";
}

/** True when trying the same request again is a reasonable suggestion. */
export function isRetryable(cause: unknown): boolean {
  if (!(cause instanceof EndpointError)) return true;
  return (
    cause.code === "timeout" ||
    cause.code === "network" ||
    cause.code === "server" ||
    cause.code === "bad-response" ||
    (cause.status !== null && cause.status >= 500)
  );
}
