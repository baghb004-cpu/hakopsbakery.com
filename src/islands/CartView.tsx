/**
 * The cart, on /cart.
 *
 * MOUNT IT WITH client:idle.
 *
 * Not client:visible: this island is the reason the page exists and it sits
 * at the top of it, so waiting for an intersection would mean waiting for
 * something that has already happened. Idle runs it as soon as the main
 * thread is free, which on this page is almost immediately.
 *
 *   <CartView client:idle catalog={cartCatalog} storeOpen={storeOpen} />
 *
 * The cart holds a sku, a variant id and a quantity, and nothing else. Names,
 * photographs and prices are joined on here from the catalog the page was
 * built from, which is why a line for a product that has since been retired
 * is a case this component handles rather than a crash.
 *
 * Prices shown are a preview. The checkout function prices the order again,
 * server side, from the same catalog. Section 4 of docs/ARCHITECTURE.md.
 */

import { useState } from "react";
import { clearCart, removeLine, setQty, type CartLine } from "@lib/cart";
import { multiplyMoney, sumMoney } from "@lib/money";
import styles from "./islands.module.css";
import { cx, plural, safeMoney, TRAYS, useCart, useHydrated, type UnitWords } from "./shared";

export interface CartViewVariant {
  readonly id: string;
  readonly label: string;
  readonly priceCents: number;
  readonly pricingStatus: "placeholder" | "confirmed";
  readonly piecesPerUnit: number | null;
  readonly sellable: boolean;
}

export interface CartViewProduct {
  readonly sku: string;
  readonly name: string;
  /** Back to the product page, so a line is a link to what it is. */
  readonly href: string;
  readonly variants: readonly CartViewVariant[];
  /** Already optimised by the page. Width and height are required. */
  readonly image?: {
    readonly src: string;
    readonly alt: string;
    readonly width: number;
    readonly height: number;
  };
}

export interface CartViewProps {
  readonly catalog: readonly CartViewProduct[];
  readonly storeOpen?: boolean;
  readonly shopHref?: string;
  readonly headingLevel?: 2 | 3;
  /** business.email, for the line under an empty or closed cart. */
  readonly contactEmail?: string;
  /** What one line is counted in. Gata is sold by the tray. */
  readonly unit?: UnitWords;
}

interface ResolvedLine {
  readonly line: CartLine;
  readonly product: CartViewProduct | null;
  readonly variant: CartViewVariant | null;
  readonly totalCents: number | null;
}

const MAX_QTY = 20;

export default function CartView({
  catalog,
  storeOpen = false,
  shopHref = "/shop",
  headingLevel = 2,
  contactEmail,
  unit = TRAYS,
}: CartViewProps) {
  const hydrated = useHydrated();
  const cart = useCart();
  const [announcement, setAnnouncement] = useState("");

  const Heading = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";

  const resolved: ResolvedLine[] = cart.lines.map((line) => {
    const product = catalog.find((p) => p.sku === line.sku) ?? null;
    const variant = product?.variants.find((v) => v.id === line.variantId) ?? null;
    const totalCents =
      variant && Number.isInteger(variant.priceCents)
        ? multiplyMoney(variant.priceCents, line.qty)
        : null;
    return { line, product, variant, totalCents };
  });

  const priced = resolved.filter((r) => r.totalCents !== null);
  const subtotalCents = sumMoney(priced.map((r) => r.totalCents ?? 0));
  const itemCount = cart.lines.reduce((sum, l) => sum + l.qty, 0);
  const hasUnknown = resolved.some((r) => r.variant === null);
  const hasPlaceholder = resolved.some((r) => r.variant?.pricingStatus === "placeholder");

  /* ---------------------------------------------------------------- */
  /* Before hydration                                                  */
  /* ---------------------------------------------------------------- */

  /*
    The cart lives in localStorage, so the static HTML genuinely cannot know
    what is in it. Rather than render an empty cart that turns out to be
    wrong a moment later, the server render says what it is doing. The rows
    below are the shape of the rows that replace them.
  */
  if (!hydrated) {
    return (
      <div className={cx(styles.island, styles.islandWide)} data-testid="cart-loading">
        <div className={styles.head}>
          <Heading className={styles.title}>Your cart</Heading>
        </div>
        <p className={styles.busy} aria-live="polite">
          Reading the cart saved in this browser.
        </p>
        <div className={styles.options} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
        <noscript>
          <div className={cx(styles.message, styles.messageWarn)}>
            <p className={styles.messageTitle}>The cart needs JavaScript</p>
            <p className={styles.messageBody}>
              It is stored in this browser rather than on a server, so with
              JavaScript switched off there is nothing to show.
              {contactEmail ? (
                <>
                  {" "}
                  You can order by writing to{" "}
                  <a href={`mailto:${contactEmail}`}>{contactEmail}</a> instead.
                </>
              ) : null}
            </p>
          </div>
        </noscript>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* The store is not open                                             */
  /* ---------------------------------------------------------------- */

  if (!storeOpen) {
    return (
      <div className={cx(styles.island, styles.islandWide)} data-testid="cart-closed">
        <div className={cx(styles.closed)}>
          <Heading className={styles.closedTitle}>Not yet taking orders</Heading>
          <p className={styles.messageBody}>
            The cottage food registration is still with the county, so payment
            is switched off. Nothing has been charged and nothing is held.
          </p>
          {cart.lines.length > 0 && (
            <p className={styles.messageBody}>
              This browser has {plural(itemCount, unit.one, unit.many)} saved from
              earlier. They will still be here when ordering opens.
            </p>
          )}
        </div>

        {cart.lines.length > 0 && (
          <>
            {/* Named, but with no price and no total: nothing here is being
                offered for sale yet, and a subtotal would imply otherwise. */}
            <ul className={styles.lines}>
              {resolved.map(({ line, product, variant }) => (
                <li className={styles.line} key={`${line.sku}:${line.variantId}`}>
                  <div className={styles.lineBody}>
                    <p className={styles.lineName}>{product?.name ?? line.sku}</p>
                    <p className={styles.lineVariant}>
                      {variant?.label ?? line.variantId}, {plural(line.qty, unit.one, unit.many)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <div className={styles.actions}>
              <button
                className={cx(styles.action, styles.actionSecondary)}
                type="button"
                onClick={() => {
                  clearCart();
                  setAnnouncement("The saved cart is empty now.");
                }}
              >
                Empty the saved cart
              </button>
            </div>
          </>
        )}

        <p className={styles.status} aria-live="polite">
          {announcement}
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Empty                                                             */
  /* ---------------------------------------------------------------- */

  if (cart.lines.length === 0) {
    return (
      <div className={cx(styles.island, styles.islandWide)} data-testid="cart-empty">
        <div className={styles.head}>
          <Heading className={styles.title}>Your cart is empty</Heading>
        </div>
        <p className={styles.lede}>Nothing is in it yet. The trays are this way.</p>
        <div className={styles.actions}>
          <a className={cx(styles.action, styles.actionPrimary)} href={shopHref}>
            See what is baking
          </a>
        </div>
        <p className={styles.status} aria-live="polite">
          {announcement}
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* The cart                                                          */
  /* ---------------------------------------------------------------- */

  function change(line: CartLine, next: number, label: string) {
    const bounded = Math.max(0, Math.min(MAX_QTY, Math.trunc(next) || 0));
    setQty(line.sku, line.variantId, bounded);
    setAnnouncement(
      bounded === 0
        ? `${label} removed from the cart.`
        : `${label}, ${plural(bounded, unit.one, unit.many)} in the cart.`,
    );
  }

  return (
    <div className={cx(styles.island, styles.islandWide)} data-testid="cart">
      <div className={styles.head}>
        <Heading className={styles.title}>Your cart</Heading>
        <p className={styles.note}>{plural(itemCount, unit.one, unit.many)}</p>
      </div>

      <ul className={styles.lines}>
        {resolved.map(({ line, product, variant, totalCents }) => {
          const label = `${product?.name ?? line.sku}, ${variant?.label ?? line.variantId}`;
          return (
            <li className={styles.line} key={`${line.sku}:${line.variantId}`}>
              {product?.image && (
                <img
                  className={styles.lineMedia}
                  src={product.image.src}
                  alt={product.image.alt}
                  width={product.image.width}
                  height={product.image.height}
                  loading="lazy"
                  decoding="async"
                />
              )}

              <div className={styles.lineBody}>
                <p className={styles.lineName}>
                  {product ? <a href={product.href}>{product.name}</a> : line.sku}
                </p>

                {variant ? (
                  <p className={styles.lineVariant}>
                    {variant.label}
                    {", "}
                    <span className="tabular" data-price={variant.priceCents}>
                      {safeMoney(variant.priceCents)}
                    </span>{" "}
                    each
                    {variant.piecesPerUnit !== null
                      ? `, ${plural(variant.piecesPerUnit, "piece", "pieces")} in the ${unit.one}`
                      : ""}
                  </p>
                ) : (
                  /* The catalog changed under a saved cart. Say so plainly
                     and give the one action that fixes it. */
                  <p className={cx(styles.lineVariant, styles.lineGone)}>
                    This tray is no longer listed, so it cannot be ordered.
                  </p>
                )}

                <div className={styles.lineFoot}>
                  <div className={styles.stepper}>
                    <button
                      className={styles.step}
                      type="button"
                      onClick={() => change(line, line.qty - 1, label)}
                      disabled={line.qty <= 1}
                      aria-label={`One fewer, ${label}`}
                    >
                      <span aria-hidden="true">&#8722;</span>
                    </button>
                    <input
                      className={cx(styles.qtyInput, "tabular")}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_QTY}
                      step={1}
                      value={line.qty}
                      data-qty={line.qty}
                      aria-label={`How many of ${label}`}
                      onChange={(event) => change(line, Number(event.target.value), label)}
                    />
                    <button
                      className={styles.step}
                      type="button"
                      onClick={() => change(line, line.qty + 1, label)}
                      disabled={line.qty >= MAX_QTY}
                      aria-label={`One more, ${label}`}
                    >
                      <span aria-hidden="true">+</span>
                    </button>
                  </div>

                  <button
                    className={cx(styles.action, styles.actionQuiet)}
                    type="button"
                    onClick={() => {
                      removeLine(line.sku, line.variantId);
                      setAnnouncement(`${label} removed from the cart.`);
                    }}
                  >
                    <span aria-hidden="true">Remove</span>
                    <span className="sr-only">Remove {label} from the cart</span>
                  </button>

                  {totalCents !== null && (
                    <span className={cx(styles.lineTotal, "tabular")} data-price={totalCents}>
                      {safeMoney(totalCents)}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.totals}>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>In the cart</span>
          <span className="tabular" data-qty={itemCount}>
            {itemCount}
          </span>
        </div>
        <div className={cx(styles.totalRow, styles.totalRowGrand)}>
          <span className={styles.totalLabel}>Subtotal</span>
          <span className="tabular" data-price={subtotalCents}>
            {safeMoney(subtotalCents)}
          </span>
        </div>
      </div>

      <p className={styles.note}>
        Delivery or shipping, and tax, are added at payment once you have
        chosen how to get it. Every price is checked again on the server
        before you are charged.
      </p>

      {hasUnknown && (
        <div className={cx(styles.message, styles.messageWarn)}>
          <p className={styles.messageTitle}>One line is out of date</p>
          <p className={styles.messageBody}>
            Something in this cart is no longer listed. Remove it and the rest
            of the order can go through.
          </p>
        </div>
      )}

      {hasPlaceholder && (
        <div className={cx(styles.message, styles.messageWarn)}>
          <p className={styles.messageTitle}>A price here is not final</p>
          <p className={styles.messageBody}>
            One of these trays is still carrying a working figure rather than
            a confirmed one. It cannot be charged for until Hakop sets it.
          </p>
        </div>
      )}

      <div className={styles.actions}>
        <a className={cx(styles.action, styles.actionQuiet)} href={shopHref}>
          Keep looking
        </a>
      </div>

      {/* One region for everything this island does, so a screen reader hears
          "removed", "two trays in the cart" and so on without the page having
          to move focus anywhere. */}
      <p className={styles.status} aria-live="polite" data-testid="cart-status">
        {announcement}
      </p>
    </div>
  );
}
