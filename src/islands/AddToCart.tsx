/**
 * The add to cart control on a product page.
 *
 * MOUNT IT WITH client:idle.
 *
 * Not client:visible: this is the primary action of the product page and it
 * is in view at load on every width, so an intersection observer would fire
 * immediately anyway and only add a frame of latency. Idle lets the
 * photography decode first and then makes the control live, which is the
 * right order for a page where the picture is what sells the thing.
 *
 *   <AddToCart
 *     client:idle
 *     sku={product.sku}
 *     productName={product.name}
 *     variants={product.variants.map(toIslandVariant)}
 *     purchasable={isPurchasable(product)}
 *     storeOpen={storeOpen}
 *   />
 *
 * The server render is a real control with a real default selection, so the
 * page is never a blank space waiting for JavaScript, and the closed state
 * needs no JavaScript at all.
 */

import { useId, useMemo, useState } from "react";
import { addLine } from "@lib/cart";
import styles from "./islands.module.css";
import { cx, plural, safeMoney, TRAYS, useHydrated, type UnitWords } from "./shared";

export interface AddToCartVariant {
  readonly id: string;
  readonly label: string;
  readonly priceCents: number;
  /** "placeholder" while the figure is still a stand in. */
  readonly pricingStatus: "placeholder" | "confirmed";
  readonly piecesPerUnit: number | null;
  /** variantIsSellable(variant) from `src/lib/catalog.ts`. */
  readonly sellable: boolean;
}

export interface AddToCartProps {
  readonly sku: string;
  readonly productName: string;
  readonly variants: readonly AddToCartVariant[];
  /** isPurchasable(product). False renders the not yet open state. */
  readonly purchasable?: boolean;
  /** storeOpen from `@config/site`, so the copy can say which thing is true. */
  readonly storeOpen?: boolean;
  readonly cartHref?: string;
  /** Where the closed state sends somebody who wants to be told. */
  readonly waitlistHref?: string;
  /** "bar" pins the control to the bottom of the scroll on a narrow screen. */
  readonly layout?: "block" | "bar";
  /** `src/lib/cart.ts` clamps at twenty per line whatever is passed here. */
  readonly maxQty?: number;
  /** What one unit is called. Gata is sold by the tray. */
  readonly unit?: UnitWords;
  readonly headingLevel?: 2 | 3;
}

const DEFAULT_MAX_QTY = 20;

export default function AddToCart({
  sku,
  productName,
  variants,
  purchasable = false,
  storeOpen = false,
  cartHref = "/cart",
  waitlistHref = "/#waitlist",
  layout = "block",
  maxQty = DEFAULT_MAX_QTY,
  unit = TRAYS,
  headingLevel = 2,
}: AddToCartProps) {
  const hydrated = useHydrated();
  const groupId = useId();
  const qtyId = `${groupId}-qty`;

  const sellable = useMemo(() => variants.filter((v) => v.sellable), [variants]);
  const choices = sellable.length > 0 ? sellable : variants;
  const first = choices[0];

  const [variantId, setVariantId] = useState<string>(first?.id ?? "");
  const [qty, setQty] = useState<number>(1);
  const [added, setAdded] = useState<string>("");

  const selected = choices.find((v) => v.id === variantId) ?? first;
  /* "Tray size" by default, and the right word if a later product is not a
     tray. The unit is one prop rather than a string repeated in the copy. */
  const sizeLegend = `${unit.one.charAt(0).toUpperCase()}${unit.one.slice(1)} size`;
  const Heading = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";

  /* ---------------------------------------------------------------- */
  /* Closed                                                            */
  /* ---------------------------------------------------------------- */

  /*
    Two different true things, and they need two different sentences. Either
    the store has not opened at all, or it is open and this particular tray
    has no confirmed price behind it. Neither is an error and neither shows
    a broken control: the customer sees a plain statement and a way to be
    told when it changes.
  */
  if (!purchasable || choices.length === 0) {
    return (
      <div className={cx(styles.island, styles.closed)} data-testid="add-to-cart-closed">
        <Heading className={styles.closedTitle}>Not yet taking orders</Heading>
        {storeOpen ? (
          <p className={styles.messageBody}>
            {productName} is not listed for sale yet. The price has to be
            confirmed before it can be sold, and it has not been.
          </p>
        ) : (
          <p className={styles.messageBody}>
            The county registration is still in progress, so the cart is
            closed. Everything else on this page is real: the tray, the
            ingredients, and the allergens.
          </p>
        )}
        <p className={styles.actions}>
          <a className={cx(styles.action, styles.actionSecondary)} href={waitlistHref}>
            Tell me when ordering opens
          </a>
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Open                                                              */
  /* ---------------------------------------------------------------- */

  const clamp = (value: number) => Math.max(1, Math.min(maxQty, Math.trunc(value) || 1));

  function onAdd() {
    if (!selected) return;
    const next = addLine(sku, selected.id, qty);
    const line = next.lines.find((l) => l.sku === sku && l.variantId === selected.id);
    const inCart = line?.qty ?? qty;
    /*
      Report what the cart actually holds, not what was asked for. The store
      clamps a line at twenty, and a customer who asked for more deserves to
      read the real number rather than be told a comfortable one.
    */
    setAdded(
      `${selected.label}, ${plural(inCart, unit.one, unit.many)} in the cart.` +
        (inCart < qty ? ` Twenty ${unit.many} is the most one line can hold.` : ""),
    );
  }

  return (
    <div
      className={cx(styles.island, layout === "bar" && styles.bar)}
      data-testid="add-to-cart"
    >
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{sizeLegend}</legend>
        <ul className={styles.options}>
          {choices.map((variant) => {
            const isSelected = selected?.id === variant.id;
            return (
              <li key={variant.id}>
                {/* The label wraps the input and also names it explicitly.
                    The wrapping alone is a valid association, but the built
                    HTML audit checks for the explicit one, and being explicit
                    survives someone later moving the input out of the label. */}
                <label
                  className={cx(styles.option, isSelected && styles.optionSelected)}
                  htmlFor={`${groupId}-variant-${variant.id}`}
                >
                  <input
                    id={`${groupId}-variant-${variant.id}`}
                    className={styles.optionInput}
                    type="radio"
                    name={`${groupId}-variant`}
                    value={variant.id}
                    checked={isSelected}
                    onChange={() => {
                      setVariantId(variant.id);
                      setAdded("");
                    }}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionLabel}>{variant.label}</span>
                    <span className={cx(styles.optionPrice, "tabular")} data-price={variant.priceCents}>
                      {safeMoney(variant.priceCents)}
                    </span>
                    {variant.piecesPerUnit !== null && (
                      <span className={styles.optionMeta}>
                        {plural(variant.piecesPerUnit, "piece", "pieces")} in the {unit.one}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className={cx(styles.field, layout === "bar" && styles.barRow)}>
        <label className={styles.label} htmlFor={qtyId}>
          How many {unit.many}
        </label>
        <div className={styles.stepper}>
          <button
            className={styles.step}
            type="button"
            onClick={() => setQty((q) => clamp(q - 1))}
            disabled={qty <= 1}
            aria-label={`One ${unit.one} fewer`}
          >
            <span aria-hidden="true">&#8722;</span>
          </button>
          <input
            className={cx(styles.qtyInput, "tabular")}
            id={qtyId}
            name="qty"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQty}
            step={1}
            value={qty}
            data-qty={qty}
            onChange={(event) => setQty(clamp(Number(event.target.value)))}
          />
          <button
            className={styles.step}
            type="button"
            onClick={() => setQty((q) => clamp(q + 1))}
            disabled={qty >= maxQty}
            aria-label={`One ${unit.one} more`}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          className={cx(styles.action, styles.actionPrimary, styles.actionLarge)}
          type="button"
          onClick={onAdd}
          disabled={!hydrated || !selected}
        >
          Add to cart
        </button>
      </div>

      {/*
        The result of the action, announced rather than flashed. Polite, so it
        waits for a screen reader to finish the label it was already reading.
      */}
      <p className={cx(styles.status, added && styles.statusGood)} aria-live="polite">
        {added ? (
          <>
            {added} <a href={cartHref}>Go to the cart</a>
          </>
        ) : (
          ""
        )}
      </p>

      {!hydrated && (
        <noscript>
          <p className={styles.note}>
            Ordering needs JavaScript for the cart to remember what you chose.
            With it switched off, the rest of this page still works.
          </p>
        </noscript>
      )}
    </div>
  );
}
