/**
 * The cart.
 *
 * Stores a SKU, a variant, and a quantity. It deliberately does NOT store a
 * price. The browser is never the authority on what something costs: the
 * checkout function looks every price up on the server from the same catalog
 * the site was built from. Brief Section 8: "The client sends a SKU and a
 * quantity, never a price. Not optional."
 *
 * Display prices shown next to the cart come from the public catalog, which
 * is fine, because they are only ever a preview of what the server will
 * charge. If the two ever disagree the server wins and the customer is told.
 */

export interface CartLine {
  sku: string;
  variantId: string;
  qty: number;
}

export interface Fulfillment {
  mode: "pickup" | "delivery" | "shipping" | null;
  /** Five digit ZIP. Validated server side before a session is created. */
  zip: string | null;
  /** ISO date of the chosen bake day. */
  bakeDate: string | null;
  /** Pickup slot id, when mode is pickup. */
  slotId: string | null;
}

export interface CartState {
  lines: CartLine[];
  fulfillment: Fulfillment;
  /** Bumped whenever the shape below changes, to discard stale carts. */
  version: number;
}

const STORAGE_KEY = "hb.cart";
const VERSION = 1;
const MAX_QTY_PER_LINE = 20;

export const emptyCart = (): CartState => ({
  lines: [],
  fulfillment: { mode: null, zip: null, bakeDate: null, slotId: null },
  version: VERSION,
});

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function readCart(): CartState {
  if (!isBrowser()) return emptyCart();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCart();
    const parsed = JSON.parse(raw) as Partial<CartState>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.lines)) return emptyCart();
    return {
      version: VERSION,
      lines: parsed.lines
        .filter(
          (l): l is CartLine =>
            typeof l?.sku === "string" &&
            typeof l?.variantId === "string" &&
            Number.isInteger(l?.qty),
        )
        .map((l) => ({ ...l, qty: clampQty(l.qty) }))
        .filter((l) => l.qty > 0),
      fulfillment: { ...emptyCart().fulfillment, ...(parsed.fulfillment ?? {}) },
    };
  } catch {
    // Private browsing, a full quota, or a corrupted value. An empty cart is
    // always a safe answer, and never an exception the page has to handle.
    return emptyCart();
  }
}

function writeCart(state: CartState): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage is unavailable. The cart still works for this page view. */
  }
}

const clampQty = (n: number) => Math.max(0, Math.min(MAX_QTY_PER_LINE, Math.trunc(n)));

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

type Listener = (state: CartState) => void;
const listeners = new Set<Listener>();
let current: CartState | null = null;

function get(): CartState {
  current ??= readCart();
  return current;
}

function set(next: CartState): void {
  current = next;
  writeCart(next);
  for (const fn of listeners) fn(next);
  // The header badge is plain inline script rather than a React island, so
  // it listens for this instead of subscribing to the store. See D-006.
  if (isBrowser()) window.dispatchEvent(new CustomEvent("hb:cart"));
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getCart = get;

export function addLine(sku: string, variantId: string, qty = 1): CartState {
  const state = get();
  const lines = [...state.lines];
  const at = lines.findIndex((l) => l.sku === sku && l.variantId === variantId);
  if (at >= 0) {
    const existing = lines[at]!;
    lines[at] = { ...existing, qty: clampQty(existing.qty + qty) };
  } else {
    lines.push({ sku, variantId, qty: clampQty(qty) });
  }
  const next = { ...state, lines: lines.filter((l) => l.qty > 0) };
  set(next);
  return next;
}

export function setQty(sku: string, variantId: string, qty: number): CartState {
  const state = get();
  const lines = state.lines
    .map((l) => (l.sku === sku && l.variantId === variantId ? { ...l, qty: clampQty(qty) } : l))
    .filter((l) => l.qty > 0);
  const next = { ...state, lines };
  set(next);
  return next;
}

export function removeLine(sku: string, variantId: string): CartState {
  return setQty(sku, variantId, 0);
}

export function setFulfillment(patch: Partial<Fulfillment>): CartState {
  const state = get();
  const next = { ...state, fulfillment: { ...state.fulfillment, ...patch } };
  set(next);
  return next;
}

export function clearCart(): CartState {
  const next = emptyCart();
  set(next);
  return next;
}

export const totalItems = (state: CartState): number =>
  state.lines.reduce((sum, l) => sum + l.qty, 0);

/*
  Keep two tabs in step. Someone adding to the cart on one tab and checking
  out on another should not see two different carts.
*/
if (isBrowser()) {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = readCart();
    for (const fn of listeners) fn(current);
  });
}
