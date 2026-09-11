/**
 * Outbound email, behind one interface.
 *
 * Two of the messages this sends are not marketing and not optional. When an
 * order is refunded because the address turned out to be outside California,
 * the customer has been charged and then not charged, and they are owed an
 * explanation in plain words. When an order is flagged, Hakop needs to know
 * before the customer calls him.
 *
 * Resend is not configured yet, so the default implementation writes the
 * message to the function log and keeps it in memory. That is a no op with
 * respect to the customer's inbox, and it says so loudly rather than
 * pretending to have sent anything.
 */

import { env } from "./env";
import type { Logger } from "./http";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. No HTML: these are short, and plain text always renders. */
  readonly text: string;
  readonly replyTo?: string;
  /** Groups messages in the provider dashboard. Not shown to the customer. */
  readonly tag?: string;
}

export type EmailResult =
  | { readonly ok: true; readonly id: string | null; readonly delivered: boolean }
  | { readonly ok: false; readonly reason: string };

export interface Emailer {
  readonly name: string;
  /** False when nothing actually reaches an inbox. */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

/* ------------------------------------------------------------------ */
/* The no op                                                           */
/* ------------------------------------------------------------------ */

export interface RecordingEmailer extends Emailer {
  readonly sent: EmailMessage[];
  reset(): void;
}

/**
 * Records and logs. Used in tests, and used in production until Resend has a
 * key, where the log line is the only copy of the message that exists.
 */
export function createRecordingEmailer(logger?: Logger): RecordingEmailer {
  const sent: EmailMessage[] = [];
  return {
    name: "recording",
    delivers: false,
    sent,
    reset() {
      sent.length = 0;
    },
    async send(message) {
      sent.push(message);
      logger?.warn("email.not-delivered", {
        to: message.to,
        subject: message.subject,
        tag: message.tag ?? null,
        note: "No email provider is configured. The message body is in this log line only.",
        body: message.text,
      });
      return { ok: true, id: null, delivered: false };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Resend                                                              */
/* ------------------------------------------------------------------ */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The real one. Drops in the moment ORDER_EMAIL_API_KEY and ORDER_EMAIL_FROM
 * are set, with no change anywhere above this file.
 *
 * The key is read once and never logged, never returned, and never included
 * in an error. A failed send returns a reason and the caller decides: for the
 * refund explanation the right answer is to flag it for Hakop to send by
 * hand, never to fail the webhook, because the refund itself has already
 * happened and retrying the whole event would attempt it again.
 */
export function createResendEmailer(apiKey: string, from: string, logger?: Logger): Emailer {
  return {
    name: "resend",
    delivers: true,
    async send(message) {
      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
            ...(message.tag === undefined ? {} : { tags: [{ name: "kind", value: message.tag }] }),
          }),
        });

        if (!response.ok) {
          /*
            The provider's body can quote the request, so it goes to the log
            and never to a caller that might put it in front of a customer.
          */
          const detail = await response.text().catch(() => "");
          logger?.error("email.provider-rejected", {
            status: response.status,
            detail: detail.slice(0, 500),
            tag: message.tag ?? null,
          });
          return { ok: false, reason: `provider-status-${response.status}` };
        }

        const payload = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return {
          ok: true,
          id: typeof payload?.id === "string" ? payload.id : null,
          delivered: true,
        };
      } catch (cause) {
        logger?.error("email.transport-failed", { message: String(cause).slice(0, 200) });
        return { ok: false, reason: "transport-failed" };
      }
    },
  };
}

/** Resend if it is configured, the recording no op if it is not. */
export function defaultEmailer(logger?: Logger): Emailer {
  const apiKey = env("ORDER_EMAIL_API_KEY");
  const from = env("ORDER_EMAIL_FROM");
  if (apiKey !== null && from !== null) return createResendEmailer(apiKey, from, logger);
  return createRecordingEmailer(logger);
}

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

/*
  Deliberately loose. The only way to know an address is real is to send to
  it, and a regular expression that tries to encode RFC 5322 rejects valid
  addresses that people actually have. This catches the typo and the empty
  box, which is all validation at this layer can honestly claim to do.
*/
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(?:\.[^\s@.,;:<>()[\]\\"]+)+$/;

/** Trimmed and lower cased, or null when it cannot be an address at all. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  /*
    254 octets is the maximum length of a deliverable address. Anything
    longer is either a mistake or an attempt to fill a column.
  */
  if (value.length === 0 || value.length > 254) return null;
  return EMAIL_SHAPE.test(value) ? value : null;
}
