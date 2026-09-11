/**
 * Live bake date availability.
 *
 * This is the Tier 2 read described in Section 1 of docs/ARCHITECTURE.md, and
 * the reason it is a network round trip rather than a value baked into the
 * page: "Sold-out dates show as sold out in the picker, not as a checkout
 * error. Nothing feels cheaper than finding out at payment."
 *
 * So the answer is never cached. Not at the edge, not in the browser, not in
 * a warm function. `cache-control: no-store` is set on every response by
 * `_shared/http.ts` and it is not an optimisation to revisit later.
 *
 * The rules themselves are pure and live in `src/lib/bake-schedule.ts`. This
 * function supplies two things that module cannot know: the configuration
 * Hakop set, and what is already committed.
 */

import type { Context } from "@netlify/functions";
import {
  buildBakeSchedule,
  findBakeDate,
  isCalendarDate,
  nextOpenBakeDate,
} from "@lib/bake-schedule";
import type { BakeScheduleConfig } from "@lib/bake-schedule";
import { clientIp, methodNotAllowed, ok, refuse, tooManyRequests } from "./_shared/http";
import { bakeScheduleConfigFromEnv } from "./_shared/env";
import { defaultOrderStore } from "./_shared/store";
import type { OrderStore } from "./_shared/store";
import { defaultRateLimiter } from "./_shared/rate-limit";
import type { RateLimiter } from "./_shared/rate-limit";

export const config = { path: "/api/check-availability" };

const RATE_RULE = { limit: 120, windowMs: 60_000 };

export interface AvailabilityDeps {
  /** Null when piecesPerBatch has not been set. Nothing is guessed. */
  readonly schedule: BakeScheduleConfig | null;
  readonly store: OrderStore;
  readonly rateLimiter: RateLimiter;
  now(): Date;
}

export async function handleCheckAvailability(req: Request, deps: AvailabilityDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const now = deps.now();
  const limit = deps.rateLimiter.check(`availability:${clientIp(req)}`, RATE_RULE, now.getTime());
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  if (deps.schedule === null) {
    /*
      No piecesPerBatch means nobody has said how much one pass through the
      kitchen produces, and there is no safe number to assume. Offering dates
      without it would sell capacity that may not exist, so the picker is
      told plainly that it cannot offer any, and Hakop sees why.
    */
    return refuse(
      503,
      "availability-not-configured",
      "Bake dates are not open yet. Set the batch size and the weekly bake " +
        "days before taking orders.",
    );
  }

  const committed = await deps.store.committedOrders(now.getTime());
  const schedule = buildBakeSchedule({ config: deps.schedule, orders: committed, now });

  const requested = new URL(req.url).searchParams.get("date");
  const match = requested === null ? null : findBakeDate(schedule, requested);

  return ok({
    timeZone: schedule.timeZone,
    today: schedule.today,
    generatedAt: schedule.generatedAt,
    dates: schedule.dates.map((entry) => ({
      date: entry.date,
      weekday: entry.weekday,
      status: entry.status,
      selectable: entry.selectable,
      cutoffAt: entry.cutoffAt,
      /*
        Remaining pieces, so the picker can say how little is left. The
        ceiling itself stays on the server: how much Hakop can bake in a day
        is his business, and a customer only needs to know what is still for
        sale.
      */
      remainingPieces: entry.capacity.remainingPieces,
    })),
    nextOpen: nextOpenBakeDate(schedule)?.date ?? null,
    requested:
      requested === null
        ? null
        : {
            date: isCalendarDate(requested) ? requested : null,
            known: match !== null,
            status: match?.status ?? null,
            selectable: match?.selectable === true,
            remainingPieces: match?.capacity.remainingPieces ?? 0,
          },
  });
}

export default async (req: Request, _context: Context): Promise<Response> =>
  handleCheckAvailability(req, {
    schedule: bakeScheduleConfigFromEnv(),
    store: defaultOrderStore(),
    rateLimiter: defaultRateLimiter(),
    now: () => new Date(),
  });
