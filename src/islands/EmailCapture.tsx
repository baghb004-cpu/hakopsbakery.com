/**
 * The waitlist form shown while the store is closed.
 *
 * MOUNT IT WITH client:visible.
 *
 * Not client:idle: this sits near the foot of a page, it is not the first
 * thing anybody does, and hydrating it early would spend main thread time on
 * a form nobody has scrolled to. The server render is the finished form, so
 * there is nothing to wait for until somebody types in it.
 *
 *   <EmailCapture client:visible source="home" contactEmail={business.email} />
 *
 * CONSENT IS A TICK, NOT AN ASSUMPTION. The subscribe function refuses a
 * request that does not carry one, and it stores the wording and its version
 * alongside the address. The wording below is that same text, so what the
 * visitor reads is what is recorded. If `subscribe.ts` changes its text, it
 * bumps SUBSCRIBE_CONSENT_VERSION, and this default has to change with it.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import styles from "./islands.module.css";
import { cx, useHydrated } from "./shared";
import {
  ENDPOINTS,
  friendlyError,
  requestJson,
  type SubscribeRequest,
  type SubscribeResponse,
} from "./endpoints";

/**
 * SUBSCRIBE_CONSENT_TEXT from netlify/functions/subscribe.ts, word for word.
 *
 * Restated rather than imported: importing a function module would pull zod
 * and the Netlify runtime types into a browser bundle. A page may override
 * it, and whoever changes the function changes this in the same sitting.
 */
const CONSENT_TEXT =
  "Email me when Hakop's Bakery opens for orders. My address is used for " +
  "that and nothing else, it is not sold or shared, and I can ask to be " +
  "taken off the list at any time.";

export interface EmailCaptureProps {
  /** Which page the signup came from, so the list means something later. */
  readonly source?: string;
  readonly endpoint?: string;
  readonly id?: string;
  readonly headingLevel?: 2 | 3;
  readonly title?: string;
  readonly lede?: string;
  /** Must match SUBSCRIBE_CONSENT_TEXT in the function. */
  readonly consentText?: string;
  readonly privacyHref?: string;
  readonly contactEmail?: string;
}

type State =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "done"; readonly message: string; readonly unsubscribe: string | null }
  | { readonly status: "failed"; readonly message: string };

const STORAGE_KEY = "hb.waitlist";

function rememberJoined(email: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ email, at: new Date().toISOString() }));
  } catch {
    /* Private browsing. They are still on the list, we just cannot say so
       the next time they visit. */
  }
}

function alreadyJoined(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export default function EmailCapture({
  source = "site",
  endpoint = ENDPOINTS.subscribe,
  id = "waitlist",
  headingLevel = 2,
  title = "Be told when ordering opens",
  lede = "Ordering is not open yet. Leave an email and you will hear when the trays go on sale.",
  consentText = CONSENT_TEXT,
  privacyHref,
  contactEmail,
}: EmailCaptureProps) {
  const hydrated = useHydrated();
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [returning, setReturning] = useState(false);
  const consentRef = useRef<HTMLInputElement | null>(null);

  const Heading = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";
  const statusId = `${fieldId}-status`;
  const consentId = `${fieldId}-consent`;
  /* The label wraps the box and also names it explicitly, so the
     association holds for the built HTML audit and for the DOM. */
  const consentBoxId = `${fieldId}-consent-box`;

  useEffect(() => {
    if (alreadyJoined()) setReturning(true);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = email.trim();
    /* The real check is `normalizeEmail` on the server. This one is here so
       a typo is caught before a round trip, not to be clever about what an
       address is allowed to look like. */
    if (trimmed.length < 3 || !trimmed.includes("@")) {
      setState({ status: "failed", message: "That does not look like an email address." });
      return;
    }
    if (!agreed) {
      setConsentError(true);
      consentRef.current?.focus();
      setState({
        status: "failed",
        message: "Tick the box to say it is fine to email you when the shop opens.",
      });
      return;
    }

    setState({ status: "sending" });
    try {
      const body: SubscribeRequest = { email: trimmed, consent: true, source, website };
      const result = await requestJson<SubscribeResponse>(endpoint, { body });
      rememberJoined(trimmed);
      setState({
        status: "done",
        message: result.message || "You are on the list.",
        unsubscribe: result.consent?.unsubscribe ?? null,
      });
    } catch (cause) {
      setState({ status: "failed", message: friendlyError(cause) });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Already on the list                                               */
  /* ---------------------------------------------------------------- */

  if (state.status === "done" || (returning && state.status === "idle")) {
    return (
      <section className={cx(styles.island, styles.closed)} id={id} data-testid="waitlist-done">
        <Heading className={styles.closedTitle}>You are on the list</Heading>
        <p className={styles.messageBody} role="status" aria-live="polite">
          {state.status === "done"
            ? state.message
            : "This browser has already signed up. You will hear once, the day the shop opens."}
        </p>
        {state.status === "done" && state.unsubscribe ? (
          <p className={styles.note}>{state.unsubscribe}</p>
        ) : contactEmail ? (
          <p className={styles.note}>
            To change the address or come off the list, write to{" "}
            <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
          </p>
        ) : null}
      </section>
    );
  }

  /* ---------------------------------------------------------------- */
  /* The form                                                          */
  /* ---------------------------------------------------------------- */

  const sending = state.status === "sending";

  return (
    <section className={styles.island} id={id} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <Heading className={styles.title} id={`${id}-title`}>
          {title}
        </Heading>
      </div>
      <p className={styles.lede}>{lede}</p>

      {/*
        No action attribute. The endpoint speaks JSON, so a plain browser
        post would land on a parse error rather than a page, and the submit
        button stays disabled until React is running so that pressing Enter
        cannot submit into nothing. The noscript block below is the fallback
        that actually works.
      */}
      <form onSubmit={(event) => void onSubmit(event)} noValidate>
        {/* A trap for robots. Off screen, out of the tab order, and hidden
            from assistive technology, so no person is ever asked to fill it. */}
        <div className={styles.honeypot} aria-hidden="true">
          <label htmlFor={`${fieldId}-website`}>Website. Leave this empty.</label>
          <input
            id={`${fieldId}-website`}
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          {/* A real label. A placeholder is an example, never the label. */}
          <label className={styles.label} htmlFor={`${fieldId}-email`}>
            Email address
          </label>
          <div className={styles.inputRow}>
            <input
              className={cx(styles.input, state.status === "failed" && styles.inputInvalid)}
              id={`${fieldId}-email`}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (state.status === "failed") setState({ status: "idle" });
              }}
              aria-describedby={statusId}
              aria-invalid={state.status === "failed" ? true : undefined}
              disabled={!hydrated || sending}
            />
            <button
              className={cx(styles.action, styles.actionPrimary)}
              type="submit"
              disabled={!hydrated || sending}
              aria-busy={sending || undefined}
            >
              {sending ? "Sending" : "Add me to the list"}
            </button>
          </div>

          <p
            className={cx(styles.status, state.status === "failed" && styles.statusBad)}
            id={statusId}
            role="status"
            aria-live="polite"
          >
            {sending && "Sending your address."}
            {state.status === "failed" && state.message}
          </p>
        </div>

        {/* The consent the function insists on, in the words it records. */}
        <label
          className={cx(styles.consent, consentError && styles.consentInvalid)}
          htmlFor={consentBoxId}
        >
          <input
            ref={consentRef}
            id={consentBoxId}
            className={styles.consentBox}
            type="checkbox"
            name="consent"
            checked={agreed}
            required
            aria-describedby={consentId}
            aria-invalid={consentError ? true : undefined}
            disabled={!hydrated || sending}
            onChange={(event) => {
              setAgreed(event.target.checked);
              if (event.target.checked) setConsentError(false);
            }}
          />
          <span className={styles.consentText} id={consentId}>
            {consentText}
          </span>
        </label>

        <p className={styles.note}>
          One email, the day ordering opens. The address is not shared with
          anybody and it is not used for anything else.
          {privacyHref ? (
            <>
              {" "}
              <a href={privacyHref}>How we handle your details</a>.
            </>
          ) : null}
        </p>
      </form>

      {!hydrated && (
        <noscript>
          <p className={styles.note}>
            This form needs JavaScript.
            {contactEmail ? (
              <>
                {" "}
                Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a> and
                Hakop will add you to the list by hand.
              </>
            ) : null}
          </p>
        </noscript>
      )}
    </section>
  );
}
