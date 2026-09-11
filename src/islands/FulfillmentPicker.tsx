/**
 * How the customer gets the tray: mode, ZIP, bake date, pickup window.
 *
 * MOUNT IT WITH client:visible.
 *
 * Not client:idle: this island makes a network request the moment it wakes
 * up, and that request must not compete with the page finishing its own
 * load. It also sits below the cart lines, so a customer who has not
 * scrolled to it has not needed it yet. Fetching when it comes into view is
 * both cheaper and fresher: availability read early is availability that has
 * had longer to go stale.
 *
 *   <FulfillmentPicker client:visible contactEmail={business.email} />
 *
 * THE ONE RULE THIS ISLAND EXISTS TO KEEP
 *
 * A sold out bake date appears here, labelled sold out, with its control
 * disabled. It is never hidden, and it is never allowed to become an error
 * at payment. Brief Section 8, and docs/ARCHITECTURE.md Section 1: "Nothing
 * feels cheaper than finding out at payment."
 *
 * It writes its answers into the cart store, so the checkout gate reads them
 * without either island knowing the other exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { setFulfillment } from "@lib/cart";
import { isCaliforniaZip, zipRejectionMessage } from "@lib/california";
import { BAKE_DATE_STATUS_LABELS } from "@lib/bake-schedule";
import type { FulfillmentMode } from "@lib/zones";
import {
  ENDPOINTS,
  friendlyError,
  isRetryable,
  requestJson,
  type AvailabilityDate,
  type AvailabilityResponse,
  type PickupSlot,
  type ZoneRequest,
  type ZoneResponse,
} from "./endpoints";
import styles from "./islands.module.css";
import { cx, formatBakeDate, formatCutoff, safeMoney, useCart, useHydrated } from "./shared";

export interface FulfillmentPickerProps {
  readonly modes?: readonly FulfillmentMode[];
  readonly pickupCity?: string;
  /**
   * Pickup windows, when there are any to offer.
   *
   * check-availability does not return these yet: Hakop has not set his
   * pickup times, and inventing a window the kitchen has not agreed to would
   * be a promise the site cannot keep. Pass a list and the control appears.
   */
  readonly pickupSlots?: readonly PickupSlot[];
  readonly availabilityEndpoint?: string;
  readonly zoneEndpoint?: string;
  /** Anchor id, so the checkout gate can link back to a missing answer. */
  readonly id?: string;
  readonly headingLevel?: 2 | 3;
  readonly contactEmail?: string;
}

/*
  The longer sentence a customer reads while choosing. `zones.ts` owns the
  one word label, and this is the line underneath it, which belongs next to
  the control it describes.
*/
const MODE_COPY: Readonly<Record<FulfillmentMode, { title: string; detail: string }>> = {
  pickup: {
    title: "Pickup",
    detail: "Collect the tray on the day it is baked.",
  },
  delivery: {
    title: "Local delivery",
    detail: "Cypress and the towns next to it. Enter a ZIP and we will check.",
  },
  shipping: {
    title: "Shipping",
    detail: "Anywhere in California. Cottage food law does not allow further.",
  },
};

const ALL_MODES: readonly FulfillmentMode[] = ["pickup", "delivery", "shipping"];

/** Dates shown before the list asks to be opened up. Four weeks is a lot. */
const VISIBLE_DATES = 14;

type Availability =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AvailabilityResponse }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

type Zone =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "allowed"; readonly message: string }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly message: string;
      /** Modes that would work for this ZIP, from the same answer. */
      readonly alternatives: readonly FulfillmentMode[];
    }
  | { readonly status: "error"; readonly message: string };

export default function FulfillmentPicker({
  modes = ALL_MODES,
  pickupCity = "Cypress",
  pickupSlots,
  availabilityEndpoint = ENDPOINTS.availability,
  zoneEndpoint = ENDPOINTS.deliveryZone,
  id = "fulfillment",
  headingLevel = 2,
  contactEmail,
}: FulfillmentPickerProps) {
  const hydrated = useHydrated();
  const cart = useCart();
  const { mode, zip, bakeDate, slotId } = cart.fulfillment;

  const [availability, setAvailability] = useState<Availability>({ status: "idle" });
  const [zone, setZone] = useState<Zone>({ status: "idle" });
  const [zipDraft, setZipDraft] = useState<string>("");
  const [showAllDates, setShowAllDates] = useState(false);
  const [dateNotice, setDateNotice] = useState("");

  /*
    The id of a control to put focus on after the next render.

    Two of the buttons in this island delete themselves the moment they are
    used: "Show N more days" has nothing left to show, and the "ship it
    instead" button belongs to a refusal that the mode change clears. A
    browser drops focus to the body when the focused element is removed, so
    pressing either one used to send a keyboard user back to the top of the
    document, several dozen Tab presses from where they were standing. Each
    of them now names where focus should land instead.
  */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (pendingFocusId === null) return;
    const target = document.getElementById(pendingFocusId);
    setPendingFocusId(null);
    if (target instanceof HTMLElement) target.focus();
  }, [pendingFocusId]);

  const Heading = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";
  const zipStatusId = `${id}-zip-status`;

  /* The ZIP already agreed with the cart should be in the box on arrival. */
  useEffect(() => {
    if (zip) setZipDraft(zip);
  }, [zip]);

  /* ---------------------------------------------------------------- */
  /* Availability, read live                                           */
  /* ---------------------------------------------------------------- */

  const abortRef = useRef<AbortController | null>(null);

  const loadAvailability = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAvailability({ status: "loading" });
    try {
      const data = await requestJson<AvailabilityResponse>(availabilityEndpoint, {
        method: "GET",
        signal: controller.signal,
      });
      setAvailability({ status: "ready", data });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setAvailability({
        status: "error",
        message: friendlyError(cause),
        retryable: isRetryable(cause),
      });
    }
  }, [availabilityEndpoint]);

  useEffect(() => {
    void loadAvailability();
    return () => abortRef.current?.abort();
  }, [loadAvailability]);

  const answer = availability.status === "ready" ? availability.data : null;
  const dates: readonly AvailabilityDate[] = answer?.dates ?? [];
  const shown = showAllDates ? dates : dates.slice(0, VISIBLE_DATES);
  const hiddenCount = Math.max(0, dates.length - shown.length);
  const chosen = dates.find((date) => date.date === bakeDate) ?? null;

  /*
    The customer may have chosen a date, gone away, and come back to a
    kitchen that has since filled up. That is exactly the case the brief
    wants handled in the picker: the stale choice is dropped here, with a
    sentence saying why, rather than surviving until payment.
  */
  useEffect(() => {
    if (availability.status !== "ready" || !bakeDate) return;
    const match = availability.data.dates.find((date) => date.date === bakeDate);
    if (match?.selectable) return;
    const why = match ? BAKE_DATE_STATUS_LABELS[match.status].toLowerCase() : "no longer offered";
    setDateNotice(
      `${formatBakeDate(bakeDate)} is ${why} now, so it has been cleared. Choose another day.`,
    );
    setFulfillment({ bakeDate: null, slotId: null });
  }, [availability, bakeDate]);

  /* ---------------------------------------------------------------- */
  /* Pickup windows                                                    */
  /* ---------------------------------------------------------------- */

  const slots = useMemo<readonly PickupSlot[]>(() => pickupSlots ?? [], [pickupSlots]);
  const openSlots = useMemo(() => slots.filter((slot) => !slot.soldOut), [slots]);

  /*
    When windows exist, one is selected for the customer rather than left
    blank. It is the earliest open window, it is visible, and it can be
    changed. A blank that silently blocks the checkout button later is worse
    than a sensible default now.
  */
  useEffect(() => {
    if (mode !== "pickup" || !bakeDate) return;
    if (slots.length === 0) {
      if (slotId !== null) setFulfillment({ slotId: null });
      return;
    }
    if (!openSlots.some((slot) => slot.id === slotId)) {
      setFulfillment({ slotId: openSlots[0]?.id ?? null });
    }
  }, [mode, bakeDate, slots, openSlots, slotId]);

  /* ---------------------------------------------------------------- */
  /* The California gate                                               */
  /* ---------------------------------------------------------------- */

  const needsZip = mode === "delivery" || mode === "shipping";

  async function checkZip(event: FormEvent) {
    event.preventDefault();
    if (!mode || !needsZip) return;
    /* The button stays focusable while the request is out, so a second press
       is refused here rather than by `disabled`. */
    if (zone.status === "checking") return;

    const local = isCaliforniaZip(zipDraft);
    if (!local.ok && local.reason === "malformed") {
      /* Five digits is a shape, not a question for a server. */
      setZone({
        status: "refused",
        reason: "zip-malformed",
        message: zipRejectionMessage("malformed"),
        alternatives: [],
      });
      return;
    }

    setZone({ status: "checking" });
    try {
      const body: ZoneRequest = { mode, zip: zipDraft.trim() };
      const result = await requestJson<ZoneResponse>(zoneEndpoint, { body });

      /*
        The whole answer comes back at once, for all three modes, so a
        refusal can name what would work instead in the same breath rather
        than sending the customer round again to find out.
      */
      const alternatives = result.modes
        .filter((entry) => entry.available && entry.mode !== mode)
        .map((entry) => entry.mode);
      const forMode = result.modes.find((entry) => entry.mode === mode) ?? null;

      if (!result.inCalifornia || result.zip === null) {
        setFulfillment({ zip: null });
        setZone({
          status: "refused",
          reason: result.reason === "malformed" ? "zip-malformed" : "out-of-state",
          message: forMode?.message ?? zipRejectionMessage(result.reason ?? "out-of-state"),
          alternatives: [],
        });
        return;
      }

      if (!forMode || !forMode.available) {
        setFulfillment({ zip: null });
        setZone({
          status: "refused",
          reason: forMode?.reason ?? "mode-unavailable",
          message: forMode?.message ?? "That is not available for this ZIP code.",
          alternatives,
        });
        return;
      }

      setFulfillment({ zip: result.zip });
      const fee = forMode.feeCents !== null && forMode.feeCents > 0 ? safeMoney(forMode.feeCents) : "";
      setZone({
        status: "allowed",
        message:
          (mode === "delivery"
            ? `${result.zip} is on the delivery run.`
            : `${result.zip} is in California, so we can ship to it.`) +
          (fee ? ` The charge for that is ${fee}.` : ""),
      });
    } catch (cause) {
      /*
        The server is the authority and it did not answer. Rather than a
        shrug, fall back to what california.ts can work out here, say plainly
        that it is not confirmed, and leave the ZIP unsaved so the checkout
        gate has to ask again.
      */
      setFulfillment({ zip: null });
      const message = friendlyError(cause);
      setZone({
        status: "error",
        message: local.ok
          ? `${message} That ZIP does look like a California one, but we could not confirm it.`
          : `${message} That ZIP is outside California, which we can tell without asking.`,
      });
    }
  }

  function chooseMode(next: FulfillmentMode) {
    /*
      The stored ZIP is dropped on every mode change, because a ZIP confirmed
      for shipping says nothing about whether Hakop drives to it. What was
      typed stays in the box, so re-checking is one tap rather than retyping.
    */
    setFulfillment({
      mode: next,
      zip: null,
      slotId: next === "pickup" ? slotId : null,
    });
    setZone({ status: "idle" });
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <section className={styles.island} id={id} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <Heading className={styles.title} id={`${id}-title`}>
          How would you like to get it
        </Heading>
      </div>

      {/* ---- Mode ---- */}
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Pickup, delivery or shipping</legend>
        <ul className={styles.options}>
          {modes.map((option) => {
            const copy = MODE_COPY[option];
            const selected = mode === option;
            return (
              <li key={option}>
                <label
                  className={cx(styles.option, selected && styles.optionSelected)}
                  htmlFor={`${id}-mode-${option}`}
                >
                  <input
                    id={`${id}-mode-${option}`}
                    className={styles.optionInput}
                    type="radio"
                    name={`${id}-mode`}
                    value={option}
                    checked={selected}
                    disabled={!hydrated}
                    onChange={() => chooseMode(option)}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionLabel}>
                      {option === "pickup" ? `${copy.title} in ${pickupCity}` : copy.title}
                    </span>
                    <span className={styles.optionMeta}>{copy.detail}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* ---- ZIP ---- */}
      {needsZip && (
        <form className={styles.field} onSubmit={(event) => void checkZip(event)} noValidate>
          <label className={styles.label} htmlFor={`${id}-zip`}>
            {mode === "delivery" ? "Delivery ZIP code" : "Shipping ZIP code"}
          </label>
          <span className={styles.hint} id={`${id}-zip-hint`}>
            Five digits. We check it before you pay, not after.
          </span>
          <div className={styles.inputRow}>
            <input
              className={cx(styles.input, zone.status === "refused" && styles.inputInvalid)}
              id={`${id}-zip`}
              name="zip"
              type="text"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={10}
              value={zipDraft}
              onChange={(event) => {
                const next = event.target.value;
                setZipDraft(next);
                if (zone.status !== "idle") setZone({ status: "idle" });
                /*
                  A confirmed ZIP belongs to the value that was in the box
                  when the server confirmed it. Editing the box withdraws the
                  confirmation, so the checkout gate asks again rather than
                  trusting a tick that is no longer about this address.
                */
                if (zip !== null && next.trim() !== zip) setFulfillment({ zip: null });
              }}
              aria-describedby={`${id}-zip-hint ${zipStatusId}`}
              aria-invalid={zone.status === "refused" ? true : undefined}
              disabled={!hydrated}
            />
            {/*
              Checking is aria-disabled rather than disabled. A browser blurs
              a focused element the moment it becomes `disabled`, so pressing
              this button with the keyboard threw focus to the body and the
              answer that arrived a moment later was announced to somebody
              who was no longer anywhere near it. Empty and unhydrated stay
              real `disabled`: neither is taken away mid press.
            */}
            <button
              className={cx(styles.action, styles.actionSecondary)}
              type="submit"
              disabled={!hydrated || zipDraft.trim().length === 0}
              aria-disabled={zone.status === "checking" || undefined}
              aria-busy={zone.status === "checking" || undefined}
            >
              {zone.status === "checking" ? "Checking" : "Check this ZIP"}
            </button>
          </div>

          {/* Every async answer lands in one live region, so the result is
              announced whether the customer is looking at it or not. */}
          <p
            className={cx(
              styles.status,
              zone.status === "allowed" && styles.statusGood,
              (zone.status === "refused" || zone.status === "error") && styles.statusBad,
            )}
            id={zipStatusId}
            role="status"
            aria-live="polite"
          >
            {zone.status === "checking" && "Checking that ZIP code."}
            {zone.status === "allowed" && zone.message}
            {zone.status === "refused" && zone.message}
            {zone.status === "error" && zone.message}
          </p>

          {/*
            Out of state is the one refusal that needs more than a line. It is
            a legal limit on this bakery, the customer has done nothing wrong,
            and saying so is the difference between a rule and a rebuke.
          */}
          {zone.status === "refused" && zone.reason === "out-of-state" && (
            <div className={cx(styles.message, styles.messageBad)}>
              <p className={styles.messageTitle}>We can only sell inside California</p>
              <p className={styles.messageBody}>
                A Class A cottage food operation is a home kitchen, and
                California law allows it to sell to customers in California
                only. It is not allowed to ship across the state line. That is
                a limit on us, and nothing to do with you.
              </p>
              <p className={styles.messageBody}>
                If the tray is a gift for somebody in California, put their ZIP
                code in instead and it will go through.
                {contactEmail ? (
                  <>
                    {" "}
                    If you are not sure, write to{" "}
                    <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
                  </>
                ) : null}
              </p>
            </div>
          )}

          {zone.status === "refused" &&
            zone.reason !== "out-of-state" &&
            zone.alternatives.length > 0 && (
              <div className={cx(styles.message, styles.messageWarn)}>
                <p className={styles.messageTitle}>Another way would work</p>
                <p className={styles.messageBody}>
                  That ZIP code is in California, so the tray can still reach
                  you. These are open to it.
                </p>
                <div className={styles.actions}>
                  {zone.alternatives.map((alternative) => (
                    <button
                      key={alternative}
                      className={cx(styles.action, styles.actionSecondary)}
                      type="button"
                      onClick={() => {
                        chooseMode(alternative);
                        /* This whole block disappears with the refusal that
                           put it here. Focus follows the answer: the mode
                           radio that is now chosen. */
                        setPendingFocusId(`${id}-mode-${alternative}`);
                      }}
                    >
                      {alternative === "pickup"
                        ? `Collect it in ${pickupCity}`
                        : alternative === "shipping"
                          ? "Ship it instead"
                          : "Have it delivered"}
                    </button>
                  ))}
                </div>
              </div>
            )}
        </form>
      )}

      {/* ---- Bake date ---- */}
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Bake day</legend>
        <span className={styles.hint}>
          Every tray is baked to order. Days that have filled up are shown
          here as sold out, so nothing is a surprise at payment.
        </span>

        {(availability.status === "loading" || availability.status === "idle") && (
          <>
            <p className={styles.busy} role="status" aria-live="polite">
              Reading the bake calendar.
            </p>
            <div className={styles.options} aria-hidden="true">
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
            </div>
          </>
        )}

        {availability.status === "error" && (
          <div className={cx(styles.message, styles.messageBad)} role="alert">
            <p className={styles.messageTitle}>The bake calendar did not load</p>
            <p className={styles.messageBody}>{availability.message}</p>
            <p className={styles.messageBody}>
              Nothing is lost. Your cart is still here, and no date can be
              chosen until the calendar answers, because a guess would be the
              sold out surprise this whole page exists to avoid.
              {contactEmail ? (
                <>
                  {" "}
                  If it keeps failing, write to{" "}
                  <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
                </>
              ) : null}
            </p>
            {availability.retryable && (
              <div className={styles.actions}>
                <button
                  className={cx(styles.action, styles.actionSecondary)}
                  type="button"
                  onClick={() => void loadAvailability()}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {availability.status === "ready" && dates.length === 0 && (
          <div className={cx(styles.message, styles.messageWarn)}>
            <p className={styles.messageTitle}>No bake days are open</p>
            <p className={styles.messageBody}>
              There is nothing on the calendar for the next few weeks.
              {contactEmail ? (
                <>
                  {" "}
                  Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a> and
                  Hakop will say when that changes.
                </>
              ) : null}
            </p>
          </div>
        )}

        {availability.status === "ready" && dates.length > 0 && (
          <>
            {/*
              The region is on the wrapper and the wrapper is always here. A
              live region that arrives already carrying its text is not
              announced by most screen readers: they watch regions that
              exist for a change, they do not read new ones. So the notice
              that a chosen bake day has filled up, which is the one thing
              this island exists to say, used to be silent. An empty div has
              no height, so nothing moves when there is nothing to say.
            */}
            <div role="status" aria-live="polite">
              {dateNotice && (
                <p className={cx(styles.status, styles.statusBad)}>{dateNotice}</p>
              )}
            </div>

            <ul className={cx(styles.options, styles.optionsGrid)}>
              {shown.map((date) => {
                const selected = bakeDate === date.date;
                return (
                  <li key={date.date}>
                    <label
                      className={cx(
                        styles.option,
                        selected && styles.optionSelected,
                        !date.selectable && styles.optionDisabled,
                      )}
                      htmlFor={`${id}-date-${date.date}`}
                    >
                      <input
                        id={`${id}-date-${date.date}`}
                        className={styles.optionInput}
                        type="radio"
                        name={`${id}-date`}
                        value={date.date}
                        checked={selected}
                        /* Disabled, so it cannot be chosen, and still on the
                           page, so the customer can see the day is gone. */
                        disabled={!date.selectable || !hydrated}
                        onChange={() => {
                          setDateNotice("");
                          setFulfillment({ bakeDate: date.date, slotId: null });
                        }}
                      />
                      <span className={styles.optionBody}>
                        <span className={styles.optionLabel}>{formatBakeDate(date.date)}</span>
                        {!date.selectable && (
                          <span
                            className={cx(
                              styles.optionState,
                              date.status === "sold-out" && styles.optionStateGone,
                            )}
                          >
                            {BAKE_DATE_STATUS_LABELS[date.status]}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {hiddenCount > 0 && (
              <div className={styles.actions}>
                <button
                  className={cx(styles.action, styles.actionQuiet)}
                  type="button"
                  onClick={() => {
                    setShowAllDates(true);
                    /* This button is gone the instant it is pressed, so it
                       hands focus to the first day it just revealed. That is
                       also the one thing the person pressed it to reach. */
                    const first = dates.slice(VISIBLE_DATES).find((date) => date.selectable);
                    if (first) setPendingFocusId(`${id}-date-${first.date}`);
                  }}
                >
                  Show {hiddenCount} more days
                </button>
              </div>
            )}

            {chosen && answer && (
              <p className={styles.note}>
                Ordering for {formatBakeDate(chosen.date)} closes{" "}
                {formatCutoff(chosen.cutoffAt, answer.timeZone)}.
              </p>
            )}
          </>
        )}
      </fieldset>

      {/* ---- Pickup window ---- */}
      {mode === "pickup" && bakeDate && (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Pickup time</legend>
          {slots.length === 0 ? (
            <p className={styles.note}>
              Times for {formatBakeDate(bakeDate)} are not posted yet. Hakop
              will agree one with you by email once the order is in.
            </p>
          ) : (
            <ul className={styles.options}>
              {slots.map((slot) => {
                const selected = slotId === slot.id;
                return (
                  <li key={slot.id}>
                    <label
                      className={cx(
                        styles.option,
                        selected && styles.optionSelected,
                        slot.soldOut && styles.optionDisabled,
                      )}
                      htmlFor={`${id}-slot-${slot.id}`}
                    >
                      <input
                        id={`${id}-slot-${slot.id}`}
                        className={styles.optionInput}
                        type="radio"
                        name={`${id}-slot`}
                        value={slot.id}
                        checked={selected}
                        disabled={slot.soldOut || !hydrated}
                        onChange={() => setFulfillment({ slotId: slot.id })}
                      />
                      <span className={styles.optionBody}>
                        <span className={styles.optionLabel}>{slot.label}</span>
                        {slot.soldOut && (
                          <span className={cx(styles.optionState, styles.optionStateGone)}>
                            Full
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}

      {!hydrated && (
        <noscript>
          <p className={styles.note}>
            Choosing a bake day needs JavaScript, because the day has to be
            checked against the kitchen as it is right now.
          </p>
        </noscript>
      )}
    </section>
  );
}
