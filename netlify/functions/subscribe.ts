/**
 * The coming soon email capture.
 *
 * The store is closed until the county issues a registration number, so this
 * is the only thing a visitor can actually do on the site today. That makes
 * it worth doing properly rather than treating it as a form that posts
 * somewhere.
 *
 * Three things it has to get right.
 *
 * CONSENT IS STATED, NOT ASSUMED. The response says in words what the
 * address will be used for, what it will not be used for, which version of
 * that promise was agreed to, and how to get off the list. The same text is
 * stored with the record, so the promise can be produced later rather than
 * remembered.
 *
 * IT DOES NOT LEAK WHO IS ON THE LIST. An address that is already stored and
 * one that is new get the identical response. Telling the difference would
 * turn this into a way to ask whether somebody's address is on file.
 *
 * NOTHING IS LOST. Supabase is not wired up yet, so the default store lives
 * in memory and a cold start empties it. Every accepted address is therefore
 * also written to the function log as a structured line, which is the only
 * durable copy that exists until the database does. See the note in the
 * summary: that line comes out the day Supabase is connected.
 */

import type { Context } from "@netlify/functions";
import { z } from "zod";
import {
  clientIp,
  consoleLogger,
  methodNotAllowed,
  ok,
  readJsonBody,
  refuse,
  tooManyRequests,
} from "./_shared/http";
import type { Logger } from "./_shared/http";
import { normalizeEmail } from "./_shared/email";
import { shopSettings } from "./_shared/env";
import type { ShopSettings } from "./_shared/env";
import { defaultOrderStore } from "./_shared/store";
import type { OrderStore } from "./_shared/store";
import { defaultRateLimiter } from "./_shared/rate-limit";
import type { RateLimiter } from "./_shared/rate-limit";

export const config = { path: "/api/subscribe" };

/**
 * What the visitor is agreeing to, word for word. Stored with every record.
 * Bump the version whenever the wording changes, and never edit the text of
 * a version that has already been agreed to by somebody.
 */
export const SUBSCRIBE_CONSENT_VERSION = "2026-09-11.a";

export const SUBSCRIBE_CONSENT_TEXT =
  "Email me when Hakop's Bakery opens for orders. My address is used for " +
  "that and nothing else, it is not sold or shared, and I can ask to be " +
  "taken off the list at any time.";

/** One address per person per hour is plenty for a list of one message. */
const PER_IP = { limit: 5, windowMs: 10 * 60_000 };
const PER_EMAIL = { limit: 3, windowMs: 60 * 60_000 };

const requestSchema = z.object({
  email: z.string().max(254),
  consent: z.boolean(),
  source: z.string().max(64).nullish(),
  /**
   * A honeypot. Real people never see this field and never fill it in, so
   * anything that arrives with it filled is a bot. It is answered exactly
   * like a success and nothing is stored, because telling a bot it was
   * caught only teaches whoever wrote it to stop filling the field in.
   */
  website: z.string().max(200).nullish(),
});

export interface SubscribeDeps {
  now(): Date;
  readonly store: OrderStore;
  readonly settings: ShopSettings;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
}

function consentBlock(at: string, contactEmail: string): Record<string, unknown> {
  return {
    recorded: true,
    text: SUBSCRIBE_CONSENT_TEXT,
    version: SUBSCRIBE_CONSENT_VERSION,
    at,
    usedFor: "One message, when the shop opens for orders.",
    notUsedFor: "Nothing else. The address is not sold, shared or passed on.",
    unsubscribe: `Write to ${contactEmail} and ask to be taken off the list.`,
  };
}

export async function handleSubscribe(req: Request, deps: SubscribeDeps): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const now = deps.now();
  const ip = clientIp(req);

  const ipLimit = deps.rateLimiter.check(`subscribe-ip:${ip}`, PER_IP, now.getTime());
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterSeconds);

  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return body.response;

  const parsed = requestSchema.safeParse(body.value);
  if (!parsed.success) {
    return refuse(400, "bad-request", "Send an email address and tick the box.");
  }
  const request = parsed.data;

  const at = now.toISOString();

  /* The honeypot. Looks like a success, stores nothing. */
  if (typeof request.website === "string" && request.website.trim() !== "") {
    deps.logger.info("subscribe.honeypot", { ip });
    return ok({ status: "subscribed", consent: consentBlock(at, deps.settings.contactEmail) });
  }

  if (request.consent !== true) {
    return refuse(
      400,
      "consent-required",
      "Tick the box to say it is fine to email you when the shop opens.",
    );
  }

  const email = normalizeEmail(request.email);
  if (email === null) {
    return refuse(400, "email-invalid", "That does not look like an email address.");
  }

  const emailLimit = deps.rateLimiter.check(`subscribe-email:${email}`, PER_EMAIL, now.getTime());
  if (!emailLimit.allowed) return tooManyRequests(emailLimit.retryAfterSeconds);

  const outcome = await deps.store.saveSubscriber({
    email,
    consentText: SUBSCRIBE_CONSENT_TEXT,
    consentVersion: SUBSCRIBE_CONSENT_VERSION,
    subscribedAt: at,
    source: request.source ?? "coming-soon",
    ip,
  });

  if (!deps.store.durable && outcome === "created") {
    /*
      The only durable copy of this address until Supabase exists. Netlify
      keeps function logs for the account, so a list can be recovered from
      them. Remove this line the day the database is connected: an address in
      a log is a copy of somebody's personal data in a place nobody is
      curating.
    */
    deps.logger.warn("subscribe.captured-to-log-only", {
      email,
      at,
      source: request.source ?? "coming-soon",
      note: "No durable store is configured. This log line is the record.",
    });
  }

  deps.logger.info("subscribe.accepted", { outcome, durable: deps.store.durable });

  /*
    Identical for a new address and one already on the list. See the note at
    the top of this file.
  */
  return ok({
    status: "subscribed",
    message: "You are on the list. You will hear once, the day the shop opens.",
    consent: consentBlock(at, deps.settings.contactEmail),
  });
}

export default async (req: Request, _context: Context): Promise<Response> =>
  handleSubscribe(req, {
    now: () => new Date(),
    store: defaultOrderStore(),
    settings: shopSettings(),
    rateLimiter: defaultRateLimiter(),
    logger: consoleLogger,
  });
