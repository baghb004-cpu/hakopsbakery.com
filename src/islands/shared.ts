/**
 * Small pieces every island needs: the cart subscription, the hydration
 * flag, date formatting for a civil date, and the order reference.
 *
 * Kept out of `src/lib/` on purpose. Everything here is about how a React
 * island behaves in a browser, and `src/lib/` is shared with Netlify
 * functions and with the build, where none of this applies.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { emptyCart, getCart, subscribe, type CartState } from "@lib/cart";
import { formatMoney } from "@lib/money";

/* ------------------------------------------------------------------ */
/* Class names                                                         */
/* ------------------------------------------------------------------ */

/**
 * Join class names, dropping anything falsy.
 *
 * `noUncheckedIndexedAccess` types a CSS module lookup as `string |
 * undefined`, and a template literal would happily render the word
 * "undefined" into a class attribute. This makes that impossible.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

/* ------------------------------------------------------------------ */
/* Hydration                                                           */
/* ------------------------------------------------------------------ */

/**
 * False during the server render and during the first client render, true
 * afterwards.
 *
 * Every island here renders a real, readable fallback in the static HTML,
 * and that HTML cannot know what is in localStorage. Gating on this means
 * the first client render matches the server render exactly, so React never
 * reports a hydration mismatch, and the swap to live state happens in the
 * next paint rather than as a flash of wrong content.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

/* ------------------------------------------------------------------ */
/* The cart                                                            */
/* ------------------------------------------------------------------ */

/**
 * One frozen empty cart for the server render. It has to be the same object
 * every time it is asked for: a fresh one per call would change identity on
 * every render and spin useSyncExternalStore forever.
 */
const SERVER_CART: CartState = emptyCart();

/**
 * The cart, live.
 *
 * Every island on the page shares one instance of `src/lib/cart.ts`, so the
 * add to cart control, the cart view, the fulfillment picker and the
 * checkout gate all read and write the same state without any of them
 * knowing the others exist. That is why the store lives in lib and not in a
 * React context.
 */
export function useCart(): CartState {
  return useSyncExternalStore(subscribe, getCart, () => SERVER_CART);
}

/* ------------------------------------------------------------------ */
/* The checkout attempt                                                */
/* ------------------------------------------------------------------ */

const CHECKOUT_KEY = "hb.checkout";

/** No I, L, O or U, so nothing read down a phone line is ambiguous. */
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * What the browser keeps about the last checkout attempt.
 *
 * The order reference is the server's. It is derived there from what is
 * actually being bought, and it arrives with the checkout response, so the
 * value recorded here is the real one rather than a guess made in advance.
 */
export interface StoredCheckout {
  /** Client side idempotency token. Sent as `requestId`. */
  attemptId: string;
  disclosureVersion?: string;
  acceptedAt?: string;
  orderRef?: string;
  bakeDate?: string;
}

function randomToken(size: number): string {
  const out: string[] = [];
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(size);
    cryptoApi.getRandomValues(bytes);
    for (const byte of bytes) out.push(REF_ALPHABET[byte % REF_ALPHABET.length] ?? "0");
  } else {
    for (let i = 0; i < size; i += 1) {
      const index = Math.floor(Math.random() * REF_ALPHABET.length);
      out.push(REF_ALPHABET[index] ?? "0");
    }
  }
  return out.join("");
}

export function readStoredCheckout(): StoredCheckout | null {
  try {
    const raw = localStorage.getItem(CHECKOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCheckout>;
    return typeof parsed.attemptId === "string" ? (parsed as StoredCheckout) : null;
  } catch {
    return null;
  }
}

export function writeStoredCheckout(value: StoredCheckout): void {
  try {
    localStorage.setItem(CHECKOUT_KEY, JSON.stringify(value));
  } catch {
    /* Private browsing or a full quota. The attempt still works for this
       page view, and the server records its own copy of the consent. */
  }
}

/**
 * A stable id for this attempt at checking out.
 *
 * It survives a reload and a failed payment, so a customer who comes back
 * and tries again is the same attempt to the server: one capacity hold and
 * one Stripe session rather than two. A genuinely new order gets a new one,
 * which happens when the cart changes or after a successful checkout.
 */
export function useAttemptId(): string {
  const [attemptId, setAttemptId] = useState<string>("");
  useEffect(() => {
    const stored = readStoredCheckout();
    if (stored) {
      setAttemptId(stored.attemptId);
      return;
    }
    const created = `att-${randomToken(10)}`;
    writeStoredCheckout({ attemptId: created });
    setAttemptId(created);
  }, []);
  return attemptId;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Format a civil date, YYYY-MM-DD, without letting the browser's own
 * timezone touch it.
 *
 * A bake date is a calendar date in Cypress. Parsing it into a local Date
 * would turn the twentieth into the nineteenth for anybody east of here, so
 * it is pinned at noon UTC and formatted in UTC, which lands on the same
 * calendar day in every zone on earth. The same reasoning, at more length,
 * is at the top of `src/lib/bake-schedule.ts`.
 */
export function formatBakeDate(
  date: string,
  options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" },
): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(parsed);
}

/**
 * Format an instant in the shop's timezone. Used for the order cutoff, which
 * is a wall clock time in Cypress and nowhere else.
 */
export function formatCutoff(isoInstant: string, timeZone: string): string {
  const parsed = new Date(isoInstant);
  if (Number.isNaN(parsed.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(parsed);
  } catch {
    /* An unknown zone string should not take the picker down. */
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(parsed);
  }
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * Format integer cents, and refuse rather than throw.
 *
 * `formatMoney` asserts, correctly, that money is a whole number of cents.
 * An island is the wrong place for that assertion to be fatal: a single bad
 * figure in a prop would take the cart down with it, and a customer cannot
 * fix that. A missing price shows as nothing, which is visibly wrong to
 * Hakop and harmless to everybody else.
 */
export function safeMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  return formatMoney(cents);
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

/** What one line of the cart is counted in. Gata is sold by the tray. */
export interface UnitWords {
  readonly one: string;
  readonly many: string;
}

export const TRAYS: UnitWords = { one: "tray", many: "trays" };

/** "1 tray", "3 trays". Plural without a parenthesised s. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
