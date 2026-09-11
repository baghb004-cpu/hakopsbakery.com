/**
 * The step between the cart and Stripe.
 *
 * MOUNT IT WITH client:visible.
 *
 * Not client:idle: it sits at the foot of the cart page, below the lines and
 * below the fulfillment picker, and nobody reaches it without scrolling. It
 * also has nothing to do until the rest of the page has been answered.
 *
 *   <CheckoutGate
 *     client:visible
 *     storeOpen={storeOpen}
 *     disclosureVersion={compliance.disclosureVersion}
 *     homeKitchenStatement={compliance.homeKitchenStatement}
 *   >
 *     <ComplianceLine variant="checkout" slot="disclosure" />
 *   </CheckoutGate>
 *
 * WHAT THIS GATE IS FOR
 *
 * 1. The required acknowledgement. California requires a cottage food
 *    operation to tell the customer the food was made in a home kitchen that
 *    is not inspected. The customer ticks a box saying they read it, and the
 *    tick is recorded with a timestamp, the version of the wording they were
 *    shown, and the order reference. If the wording changes later, every
 *    consent already recorded still names the wording that was on screen.
 * 2. The California gate, in the browser. The ZIP is checked through
 *    check-delivery-zone before a Stripe session is ever requested. This is
 *    the first of the three places that check runs, and the easiest to
 *    bypass, which is why the function checks it again and the webhook
 *    checks the final address a third time. docs/ARCHITECTURE.md Section 5.
 * 3. Saying what is still missing. A disabled button that will not say why
 *    is the worst control on the internet.
 */

import { useId, useRef, useState, type ReactNode } from "react";
import { setFulfillment } from "@lib/cart";
import styles from "./islands.module.css";
import {
  ENDPOINTS,
  EndpointError,
  friendlyError,
  requestJson,
  type CheckoutRequest,
  type CheckoutResponse,
  type ZoneRequest,
  type ZoneResponse,
} from "./endpoints";
import {
  cx,
  formatBakeDate,
  plural,
  TRAYS,
  useAttemptId,
  useCart,
  useHydrated,
  writeStoredCheckout,
  type UnitWords,
} from "./shared";

export interface CheckoutGateProps {
  readonly storeOpen?: boolean;
  /** compliance.disclosureVersion. Recorded with every consent. */
  readonly disclosureVersion: string;
  /** compliance.homeKitchenStatement, word for word. Never paraphrased. */
  readonly homeKitchenStatement: string;
  /**
   * The rendered <ComplianceLine variant="checkout" /> passed in as a named
   * slot from the page, so the legally required wording has exactly one
   * source in this codebase. When it is absent the statement above is shown
   * on its own, which is the minimum the law asks for.
   */
  readonly disclosure?: ReactNode;
  readonly checkoutEndpoint?: string;
  readonly zoneEndpoint?: string;
  /** Anchor of the FulfillmentPicker, for the links that fix a gap. */
  readonly pickerHref?: string;
  readonly shopHref?: string;
  readonly allergenHref?: string;
  readonly contactEmail?: string;
  readonly headingLevel?: 2 | 3;
  /** What one line is counted in. Gata is sold by the tray. */
  readonly unit?: UnitWords;
}

type Submission =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "sending" }
  | { readonly status: "leaving" }
  | { readonly status: "failed"; readonly title: string; readonly message: string };

interface Requirement {
  readonly id: string;
  readonly met: boolean;
  readonly label: string;
  readonly href?: string;
}

export default function CheckoutGate({
  storeOpen = false,
  disclosureVersion,
  homeKitchenStatement,
  disclosure,
  checkoutEndpoint = ENDPOINTS.checkout,
  zoneEndpoint = ENDPOINTS.deliveryZone,
  pickerHref = "#fulfillment",
  shopHref = "/shop",
  allergenHref = "/legal/allergens",
  contactEmail,
  headingLevel = 2,
  unit = TRAYS,
}: CheckoutGateProps) {
  const hydrated = useHydrated();
  const cart = useCart();
  const attemptId = useAttemptId();

  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });
  const consentRef = useRef<HTMLInputElement | null>(null);
  /* Generated, so two gates on one page cannot collide on an id. */
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const consentDetailId = `${baseId}-consent`;
  const consentErrorId = `${baseId}-consent-error`;
  /* The label wraps the box and also names it explicitly, so the association
     holds for the built HTML audit and for anything that reads the DOM. */
  const consentBoxId = `${baseId}-consent-box`;

  const Heading = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";
  const { mode, zip, bakeDate, slotId } = cart.fulfillment;
  const itemCount = cart.lines.reduce((sum, line) => sum + line.qty, 0);
  const needsZip = mode === "delivery" || mode === "shipping";
  const busy =
    submission.status === "checking" ||
    submission.status === "sending" ||
    submission.status === "leaving";

  /* ---------------------------------------------------------------- */
  /* Closed                                                            */
  /* ---------------------------------------------------------------- */

  if (!storeOpen) {
    return (
      <div className={cx(styles.island, styles.closed)} data-testid="checkout-closed">
        <Heading className={styles.closedTitle}>Not yet taking orders</Heading>
        <p className={styles.messageBody}>
          Payment opens when the Orange County registration number is issued.
          Until then there is nothing to pay and no card details are collected
          anywhere on this site.
        </p>
        <div className={styles.actions}>
          <a className={cx(styles.action, styles.actionSecondary)} href={shopHref}>
            See the trays
          </a>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* What is still missing                                             */
  /* ---------------------------------------------------------------- */

  /*
    `zip` is only ever written by the fulfillment picker after
    check-delivery-zone has allowed it, so a value here means checked, not
    typed. It is checked again below before a session is created.
  */
  const requirements: Requirement[] = [
    { id: "items", met: cart.lines.length > 0, label: "Something in the cart", href: shopHref },
    { id: "mode", met: mode !== null, label: "Pickup, delivery or shipping chosen", href: pickerHref },
    /* Only asked for when the mode actually needs one. Pickup happens at the
       door, so a ZIP would be theatre. */
    ...(needsZip
      ? [{ id: "zip", met: zip !== null, label: "A ZIP code we have checked", href: pickerHref }]
      : []),
    { id: "date", met: bakeDate !== null, label: "A bake day chosen", href: pickerHref },
  ];

  const missing = requirements.filter((r) => !r.met);
  const ready = missing.length === 0;

  /* ---------------------------------------------------------------- */
  /* Submit                                                            */
  /* ---------------------------------------------------------------- */

  async function onSubmit() {
    /* The button stays focusable while a request is in flight, so it has to
       refuse a second press itself rather than leaning on `disabled`. */
    if (busy) return;
    /*
      One alert, next to the box that is wrong, and focus moved onto it.
      Setting a failed submission here as well fired a second role="alert"
      in the same tick saying the same thing further down the page, and a
      screen reader read both. The unticked box is not a failed order: no
      request was made and there is nothing to say about the cart or the
      card.
    */
    if (!agreed) {
      setConsentError(true);
      setSubmission({ status: "idle" });
      consentRef.current?.focus();
      return;
    }
    /* mode and bakeDate are named again rather than leaning on `ready`,
       because the request shape below requires both to be real strings and a
       list of booleans cannot say so. */
    if (!ready || mode === null || bakeDate === null) {
      setSubmission({
        status: "failed",
        title: "Something is still missing",
        message: `Still to do: ${missing.map((m) => m.label.toLowerCase()).join(", ")}.`,
      });
      return;
    }

    const acceptedAt = new Date().toISOString();
    /*
      Written before the request, so the browser holds a record of the tick
      even if the network never answers. The order reference is added below,
      when the server issues one: it is derived there from what is actually
      being bought, and the browser is not the authority on it.
    */
    writeStoredCheckout({ attemptId, disclosureVersion, acceptedAt });

    try {
      /* The California gate, immediately before the money. */
      if (needsZip && zip !== null) {
        setSubmission({ status: "checking" });
        const zoneBody: ZoneRequest = { mode, zip };
        const zoneAnswer = await requestJson<ZoneResponse>(zoneEndpoint, { body: zoneBody });
        const forMode = zoneAnswer.modes.find((entry) => entry.mode === mode) ?? null;
        if (!zoneAnswer.inCalifornia || !forMode || !forMode.available) {
          /* Withdraw the confirmation so the picker asks again rather than
             showing a tick that is no longer true. */
          setFulfillment({ zip: null });
          setSubmission({
            status: "failed",
            title: "That address cannot be served",
            message:
              forMode?.message ??
              "That ZIP code is outside California. A home kitchen operation " +
                "can only sell inside the state.",
          });
          return;
        }
      }

      setSubmission({ status: "sending" });
      const body: CheckoutRequest = {
        /* A sku, a variant id and a quantity. No price, ever. */
        lines: cart.lines,
        fulfillment: { mode, zip, bakeDate, slotId },
        consent: { accepted: true, version: disclosureVersion },
        requestId: attemptId,
      };
      const result = await requestJson<CheckoutResponse>(checkoutEndpoint, { body });

      if (typeof result.url !== "string" || result.url.length === 0) {
        setSubmission({
          status: "failed",
          title: "Payment did not open",
          message: "The server did not send us anywhere to pay. Nothing was charged.",
        });
        return;
      }

      /* The consent record, completed with the reference the server issued. */
      writeStoredCheckout({
        attemptId,
        disclosureVersion,
        acceptedAt,
        orderRef: result.orderRef,
        bakeDate: result.bakeDate,
      });

      setSubmission({ status: "leaving" });
      window.location.assign(result.url);
    } catch (cause) {
      const code = cause instanceof EndpointError ? cause.code : "";
      const message = friendlyError(cause);
      const reference = cause instanceof EndpointError ? cause.detail("reference") : null;

      /*
        A date that filled up while this cart sat open belongs back in the
        picker, not in a dead end here. The day is cleared, the reason is
        the server's own sentence, and the cart is untouched.
      */
      if (code.startsWith("bake-date-")) {
        setFulfillment({ bakeDate: null, slotId: null });
        setSubmission({
          status: "failed",
          title: code === "bake-date-sold-out" ? "That day filled up" : "That day will not work",
          message: `${message} Choose another bake day and nothing else is lost.`,
        });
        return;
      }
      if (
        code === "out-of-state" ||
        code === "outside-delivery-area" ||
        code === "zip-malformed" ||
        code === "zip-missing" ||
        code === "mode-unavailable" ||
        code === "below-minimum"
      ) {
        setFulfillment({ zip: null });
        setSubmission({ status: "failed", title: "That address cannot be served", message });
        return;
      }
      if (code === "consent-version-stale") {
        setSubmission({
          status: "failed",
          title: "This page is out of date",
          message:
            "The home kitchen wording has changed since this page was loaded. " +
            "Reload it and tick the box again, so what is recorded is what you read.",
        });
        return;
      }
      setSubmission({
        status: "failed",
        title: "The order did not go through",
        message: `${message} Nothing has been charged.${
          reference ? ` Quote reference ${reference} if you write to us.` : ""
        }`,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <section className={styles.island} aria-labelledby={titleId} data-testid="checkout-gate">
      <div className={styles.head}>
        <Heading className={styles.title} id={titleId}>
          Before you pay
        </Heading>
      </div>

      <dl className={styles.summary}>
        <div className={styles.summaryRow}>
          <dt className={styles.summaryLabel}>In the cart</dt>
          <dd className={styles.summaryValue}>{plural(itemCount, unit.one, unit.many)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt className={styles.summaryLabel}>Getting it</dt>
          <dd className={styles.summaryValue}>
            {mode === "pickup" && "Pickup"}
            {mode === "delivery" && `Delivery to ${zip ?? "a ZIP we still need"}`}
            {mode === "shipping" && `Shipping to ${zip ?? "a ZIP we still need"}`}
            {mode === null && "Not chosen yet"}
          </dd>
        </div>
        <div className={styles.summaryRow}>
          <dt className={styles.summaryLabel}>Bake day</dt>
          <dd className={styles.summaryValue}>
            {bakeDate ? formatBakeDate(bakeDate) : "Not chosen yet"}
          </dd>
        </div>
      </dl>

      {!ready && (
        <div className={cx(styles.message, styles.messageWarn)}>
          <p className={styles.messageTitle}>Still to answer</p>
          <ul className={styles.checklist}>
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className={cx(styles.checkItem, requirement.met && styles.checkItemDone)}
              >
                <span className={styles.checkMark} aria-hidden="true">
                  {requirement.met ? "✓" : "○"}
                </span>
                <span>
                  <span className="sr-only">{requirement.met ? "Done. " : "Still to do. "}</span>
                  {requirement.met || !requirement.href ? (
                    requirement.label
                  ) : (
                    <a href={requirement.href}>{requirement.label}</a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The disclosure itself. The page passes ComplianceLine in as a slot so
          there is one copy of this wording in the codebase. */}
      {disclosure ?? (
        <div className={cx(styles.message)}>
          <p className={styles.messageTitle}>{homeKitchenStatement}</p>
          <p className={styles.messageBody}>
            This food is made in a private home kitchen that is not subject to
            the routine inspection a commercial kitchen gets. If you have a
            food allergy, read the <a href={allergenHref}>allergen statement</a>{" "}
            before ordering.
          </p>
        </div>
      )}

      <label
        className={cx(styles.consent, consentError && styles.consentInvalid)}
        htmlFor={consentBoxId}
      >
        <input
          ref={consentRef}
          id={consentBoxId}
          className={styles.consentBox}
          type="checkbox"
          name="home-kitchen-acknowledgement"
          checked={agreed}
          required
          aria-describedby={
            consentError ? `${consentDetailId} ${consentErrorId}` : consentDetailId
          }
          aria-invalid={consentError ? true : undefined}
          disabled={!hydrated || busy}
          onChange={(event) => {
            setAgreed(event.target.checked);
            if (event.target.checked) setConsentError(false);
          }}
        />
        <span className={styles.consentText}>
          <strong>{homeKitchenStatement}</strong>
          <span className={styles.hint} id={consentDetailId}>
            Tick to confirm you have read this. Required before an order can be
            taken, and recorded with the date and the wording you were shown.
          </span>
        </span>
      </label>

      {consentError && (
        <p className={styles.errorText} id={consentErrorId} role="alert">
          The acknowledgement has to be ticked before you can pay.
        </p>
      )}

      <div className={styles.actions}>
        {/*
          Busy is aria-disabled, not disabled, and the difference matters on
          the one control on this site that takes money. A focused element
          that becomes `disabled` is blurred by the browser, so pressing
          Enter here used to throw focus to the body: the person waiting for
          Stripe had to Tab from the skip link back down the whole page to
          reach the error message when it failed. aria-disabled keeps the
          button focusable and says the same thing to a screen reader, and
          `onSubmit` refuses a second press itself.

          `disabled` is still right for the two states that are not
          transient. Nothing is taken away from under anyone there.
        */}
        <button
          className={cx(styles.action, styles.actionPrimary, styles.actionLarge)}
          type="button"
          onClick={() => void onSubmit()}
          disabled={!hydrated || cart.lines.length === 0}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
        >
          {submission.status === "checking" && "Checking the address"}
          {submission.status === "sending" && "Opening payment"}
          {submission.status === "leaving" && "Taking you to payment"}
          {(submission.status === "idle" || submission.status === "failed") && "Continue to payment"}
        </button>
      </div>

      {/* Every state of the submission is announced from one place. An error
          is a heading and a sentence, never a red border on its own. */}
      <div role="status" aria-live="polite">
        {busy && (
          <p className={styles.busy}>
            {submission.status === "checking" &&
              "Checking that we are allowed to deliver there."}
            {submission.status === "sending" && "Asking Stripe for a secure payment page."}
            {submission.status === "leaving" && "Payment is open. Taking you there now."}
          </p>
        )}
      </div>

      {submission.status === "failed" && (
        <div className={cx(styles.message, styles.messageBad)} role="alert">
          <p className={styles.messageTitle}>{submission.title}</p>
          <p className={styles.messageBody}>{submission.message}</p>
          <p className={styles.messageBody}>
            Your cart is untouched and no card has been charged.
            {contactEmail ? (
              <>
                {" "}
                If this keeps happening, write to{" "}
                <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
              </>
            ) : null}
          </p>
          <div className={styles.actions}>
            <a className={cx(styles.action, styles.actionSecondary)} href={pickerHref}>
              Back to the choices
            </a>
          </div>
        </div>
      )}

      <p className={styles.note}>
        Payment is taken by Stripe on their own page. No card number touches
        this site. Prices are worked out again on the server from the catalog
        before you are charged, so what you pay is what is listed.
      </p>

      {!hydrated && (
        <noscript>
          <p className={styles.note}>
            Checkout needs JavaScript. The acknowledgement above still applies
            to every order, however it is placed.
          </p>
        </noscript>
      )}
    </section>
  );
}
