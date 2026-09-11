/**
 * Is this ZIP one we can sell to, and how?
 *
 * A thin wrapper over `src/lib/california.ts` and `src/lib/zones.ts`. All of
 * the logic is in those two modules, and the browser runs the same code, so
 * why does this exist at all?
 *
 * Because the delivery area, the fees and the minimums are configuration
 * that belongs to the business, and a customer must never be told something
 * different from what checkout will enforce. This endpoint answers from the
 * server's copy of that configuration. It is the first of the three places
 * the California gate is enforced (Section 5 of docs/ARCHITECTURE.md) and it
 * is the only one of the three a determined person can walk around, which is
 * why the other two exist.
 *
 * This endpoint answers 200 for any well formed request. A ZIP in Nevada is
 * not an error, it is an answer, and the shape of the answer is the same
 * either way: the caller reads `inCalifornia` and `modes`, never the status
 * code.
 */

import type { Context } from "@netlify/functions";
import { isCaliforniaZip } from "@lib/california";
import { FULFILLMENT_MODES, isFulfillmentMode, resolveFulfillment } from "@lib/zones";
import type { FulfillmentConfig, FulfillmentMode } from "@lib/zones";
import { clientIp, methodNotAllowed, ok, readJsonBody, refuse, tooManyRequests } from "./_shared/http";
import { fulfillmentConfigFromEnv } from "./_shared/env";
import { defaultRateLimiter } from "./_shared/rate-limit";
import type { RateLimiter } from "./_shared/rate-limit";

export const config = { path: "/api/check-delivery-zone" };

const RATE_RULE = { limit: 60, windowMs: 60_000 };

export interface ZoneDeps {
  readonly fulfillment: FulfillmentConfig;
  readonly rateLimiter: RateLimiter;
  now(): Date;
}

interface ZoneRequest {
  readonly zip: string | null;
  readonly mode: FulfillmentMode | null;
  readonly subtotalCents: number | undefined;
}

function readRequest(source: Record<string, unknown>): ZoneRequest {
  const rawZip = source["zip"];
  const rawMode = source["mode"];
  const rawSubtotal = source["subtotalCents"];

  return {
    zip: typeof rawZip === "string" ? rawZip : null,
    mode: isFulfillmentMode(rawMode) ? rawMode : null,
    /*
      A courtesy only. The minimum that decides anything is checked in
      create-checkout-session against a subtotal the server worked out from
      the catalog. A number sent from a browser is a hint about what to show,
      never a fact about what is owed.
    */
    subtotalCents:
      typeof rawSubtotal === "number" && Number.isFinite(rawSubtotal) && rawSubtotal >= 0
        ? Math.round(rawSubtotal)
        : undefined,
  };
}

export async function handleCheckDeliveryZone(req: Request, deps: ZoneDeps): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const limit = deps.rateLimiter.check(`zone:${clientIp(req)}`, RATE_RULE, deps.now().getTime());
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  let source: Record<string, unknown>;
  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    source = {
      zip: params.get("zip"),
      mode: params.get("mode"),
      subtotalCents: params.has("subtotalCents") ? Number(params.get("subtotalCents")) : undefined,
    };
  } else {
    const body = await readJsonBody(req, 2 * 1024);
    if (!body.ok) return body.response;
    if (body.value === null || typeof body.value !== "object" || Array.isArray(body.value)) {
      return refuse(400, "bad-request", "Send a JSON object with a zip.");
    }
    source = body.value as Record<string, unknown>;
  }

  const request = readRequest(source);
  if (request.zip === null || request.zip.trim() === "") {
    return refuse(400, "zip-missing", "Enter a ZIP code and we will check it.");
  }

  const california = isCaliforniaZip(request.zip);

  /*
    Every mode is resolved, not just the one asked about, so the picker can
    show a customer in Sacramento that shipping is open to them in the same
    breath as telling them delivery is not. One round trip, one answer, and
    no chance of the two disagreeing.
  */
  const modes = FULFILLMENT_MODES.map((mode) => {
    const result = resolveFulfillment(mode, request.zip, deps.fulfillment, request.subtotalCents);
    if (result.ok) {
      return {
        mode,
        available: true,
        feeCents: result.feeCents,
        minimumOrderCents: result.minimumOrderCents,
        reason: null,
        message: null,
        shortfallCents: null,
      };
    }
    return {
      mode,
      available: false,
      feeCents: null,
      minimumOrderCents: null,
      reason: result.reason,
      message: result.message,
      shortfallCents: result.shortfallCents,
    };
  });

  return ok({
    zip: california.ok ? california.zip : null,
    inCalifornia: california.ok,
    reason: california.ok ? null : california.reason,
    modes,
    requestedMode: request.mode,
    /*
      Stated in the response rather than assumed by the caller, so that a
      client written against this endpoint cannot quietly offer a fourth
      option that does not exist.
    */
    sellsOnlyInCalifornia: true,
  });
}

export default async (req: Request, _context: Context): Promise<Response> =>
  handleCheckDeliveryZone(req, {
    fulfillment: fulfillmentConfigFromEnv(),
    rateLimiter: defaultRateLimiter(),
    now: () => new Date(),
  });
