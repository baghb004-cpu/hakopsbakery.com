/**
 * The order store, behind one interface.
 *
 * Everything that has to survive a request lives here: capacity holds, paid
 * orders, consent evidence, admin flags, processed webhook event ids, and
 * the mailing list. There is one implementation today, in memory, and one
 * contract written out in full for the Supabase implementation that replaces
 * it. Nothing above this file knows which it is talking to.
 *
 * THE IN MEMORY IMPLEMENTATION IS NOT PRODUCTION STORAGE
 *
 * It lives in one Node process. A cold start empties it, and two concurrent
 * function instances do not share it, so two customers can take the same
 * last batch. That is exactly the bug the brief asks to prevent, so
 * `create-checkout-session` refuses to run at all when the store is open and
 * the storage is not durable. The store is closed today, so the memory
 * implementation is what tests and local development use, and it is enough
 * for both.
 *
 * WHY reserve() TAKES THE CAPACITY AND NOT THE SCHEDULE
 *
 * Deciding whether a date is sold out has to be one atomic step: read the
 * committed pieces, compare, and write the hold, with nobody else moving in
 * between. The schedule rules are pure and live in `src/lib/bake-schedule.ts`,
 * so the caller computes the ceiling for the date and hands it in, and the
 * store does the compare and the write together. In Postgres that is one
 * statement inside one transaction. In memory it is one synchronous block.
 */

import { calendarYearIn } from "@lib/bake-schedule";
import type { CommittedOrder, IsoDate } from "@lib/bake-schedule";

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

export interface CapacityHold {
  readonly holdId: string;
  readonly bakeDate: IsoDate;
  readonly pieces: number;
  /** Epoch milliseconds. An unconfirmed hold past this releases its pieces. */
  readonly expiresAt: number;
  readonly confirmed: boolean;
  readonly orderRef: string;
}

export type OrderStatus =
  | "paid"
  | "refunded-out-of-state"
  | "refund-failed"
  | "cancelled";

export interface OrderLineRecord {
  readonly sku: string;
  readonly variantId: string;
  readonly qty: number;
  readonly unitPriceCents: number;
  readonly piecesPerUnit: number;
}

export interface OrderRecord {
  readonly orderRef: string;
  readonly sessionId: string;
  readonly paymentIntentId: string | null;
  readonly status: OrderStatus;
  readonly bakeDate: IsoDate;
  readonly mode: string;
  readonly zip: string | null;
  readonly lines: readonly OrderLineRecord[];
  readonly piecesTotal: number;
  readonly amountTotalCents: number;
  readonly amountTaxCents: number;
  /**
   * Product plus shipping, excluding tax. The one number the Class A annual
   * ceiling is measured in. See cap.ts.
   */
  readonly capContributionCents: number;
  readonly customerEmail: string | null;
  readonly createdAt: string;
}

export interface ConsentRecord {
  readonly orderRef: string;
  readonly sessionId: string | null;
  /** The statement word for word, as the customer saw it. */
  readonly statement: string;
  readonly acknowledgement: string;
  readonly version: string;
  readonly county: string | null;
  readonly registrationNumber: string | null;
  readonly acceptedAt: string;
  readonly source: "checkout" | "webhook" | "subscribe";
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** What Stripe recorded as its own second layer, when it recorded anything. */
  readonly stripeTermsOfService?: string | null;
}

export interface AdminFlag {
  readonly code: string;
  readonly orderRef: string | null;
  readonly sessionId: string | null;
  readonly detail: string;
  readonly createdAt: string;
  readonly context?: Record<string, unknown>;
}

export interface Subscriber {
  readonly email: string;
  readonly consentText: string;
  readonly consentVersion: string;
  readonly subscribedAt: string;
  readonly source: string;
  readonly ip: string | null;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type ReserveResult =
  | { readonly ok: true; readonly hold: CapacityHold; readonly remainingPieces: number; readonly reused: boolean }
  | { readonly ok: false; readonly reason: "sold-out"; readonly remainingPieces: number };

/** What a webhook event id is doing the moment it arrives. */
export type EventClaim = "fresh" | "in-flight" | "done";

export interface ReserveInput {
  readonly holdId: string;
  readonly bakeDate: IsoDate;
  readonly pieces: number;
  /** Total pieces this date can hold, computed from the schedule rules. */
  readonly capacityPieces: number;
  readonly orderRef: string;
  readonly expiresAt: number;
  readonly now: number;
}

export interface OrderStore {
  readonly name: string;
  /** False for anything that does not survive a cold start. */
  readonly durable: boolean;

  /** Everything currently claiming capacity: paid orders and live holds. */
  committedOrders(now: number): Promise<readonly CommittedOrder[]>;

  /** Check and claim in one step, or refuse. Never two steps. */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  releaseHold(holdId: string): Promise<void>;
  /**
   * Mark the hold behind a paid order as confirmed. A confirmed hold claims
   * its pieces for good, expiry or not, because the order is paid and the
   * pieces are really going to be baked.
   *
   * False means there was no LIVE hold to confirm: either nothing under that
   * id, or one that had already expired and released its pieces back to the
   * date. Either way the date may have been sold to somebody else in the
   * meantime, so the caller must raise it rather than let a bake day be
   * quietly oversold. An expired hold is still confirmed on the way out, so
   * that its pieces start counting again and the date is not oversold twice.
   */
  confirmHold(holdId: string, orderRef: string, now: number): Promise<boolean>;

  /**
   * Claim a Stripe event id. "fresh" means this process owns it and must
   * either complete or fail it. Anything else means somebody already has it.
   */
  beginEvent(eventId: string, now: number): Promise<EventClaim>;
  completeEvent(eventId: string): Promise<void>;
  failEvent(eventId: string): Promise<void>;

  recordOrder(order: OrderRecord): Promise<void>;
  findOrderBySession(sessionId: string): Promise<OrderRecord | null>;
  recordConsent(record: ConsentRecord): Promise<void>;
  flag(flag: AdminFlag): Promise<void>;

  saveSubscriber(subscriber: Subscriber): Promise<"created" | "existing">;

  /**
   * Product plus shipping, excluding tax, for one calendar year.
   *
   * The year is the shop's calendar year, so the timezone is part of the
   * question rather than something the caller and the store each assume
   * separately. An order placed on the evening of the thirty first of
   * December in Cypress belongs to that year, not to the UTC one that has
   * already started.
   */
  capTotalCents(year: number, timeZone: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* The in memory implementation                                        */
/* ------------------------------------------------------------------ */

interface MemoryState {
  holds: Map<string, CapacityHold>;
  orders: Map<string, OrderRecord>;
  events: Map<string, { state: "in-flight" | "done"; at: number }>;
  consents: ConsentRecord[];
  flags: AdminFlag[];
  subscribers: Map<string, Subscriber>;
}

/**
 * Visible to tests so they can assert on what was written, which is the
 * whole point of an adapter: the assertions are about behaviour, not about
 * which database happens to be behind it.
 */
export interface MemoryOrderStore extends OrderStore {
  readonly state: MemoryState;
  reset(): void;
}

/**
 * How long a webhook event may sit claimed before another delivery of it may
 * take the claim over. Longer than any function is allowed to run, so a claim
 * this old belongs to a process that is not coming back.
 */
const STALE_CLAIM_MS = 5 * 60_000;

function livePieces(state: MemoryState, bakeDate: IsoDate, now: number): number {
  let total = 0;
  for (const hold of state.holds.values()) {
    if (hold.bakeDate !== bakeDate) continue;
    if (!hold.confirmed && hold.expiresAt <= now) continue;
    total += hold.pieces;
  }
  return total;
}

export function createMemoryOrderStore(): MemoryOrderStore {
  const state: MemoryState = {
    holds: new Map(),
    orders: new Map(),
    events: new Map(),
    consents: [],
    flags: [],
    subscribers: new Map(),
  };

  return {
    name: "memory",
    durable: false,
    state,

    reset() {
      state.holds.clear();
      state.orders.clear();
      state.events.clear();
      state.consents.length = 0;
      state.flags.length = 0;
      state.subscribers.clear();
    },

    async committedOrders(now) {
      const out: CommittedOrder[] = [];
      for (const hold of state.holds.values()) {
        if (!hold.confirmed && hold.expiresAt <= now) continue;
        out.push({ bakeDate: hold.bakeDate, lines: [{ qty: hold.pieces, piecesPerUnit: 1 }] });
      }
      return out;
    },

    async reserve(input) {
      /*
        Idempotent on the hold id. A customer who double taps the pay button,
        or a browser that retries a request it never saw the answer to, sends
        the same request twice and must not claim the capacity twice. The
        hold id is derived from the contents of the request, so the second
        attempt finds its own hold and is handed it back.
      */
      const existing = state.holds.get(input.holdId);
      if (existing !== undefined && (existing.confirmed || existing.expiresAt > input.now)) {
        /*
          A retry gets a fresh session, and that session runs to a later
          expiry than the first one did. The hold has to cover it. A hold
          that expired before the session it backs would let somebody pay for
          capacity that has already been given away, which is the one thing
          this whole path exists to prevent. A confirmed hold is already paid
          for and is never moved.
        */
        const extend = !existing.confirmed && input.expiresAt > existing.expiresAt;
        const hold = extend ? { ...existing, expiresAt: input.expiresAt } : existing;
        if (extend) state.holds.set(input.holdId, hold);

        const committed = livePieces(state, input.bakeDate, input.now);
        return {
          ok: true,
          hold,
          remainingPieces: Math.max(0, input.capacityPieces - committed),
          reused: true,
        };
      }

      /*
        Reaching here means there is no live hold under this id: either
        nothing at all, or one that expired unconfirmed. livePieces already
        skips an expired unconfirmed hold, so its pieces must NOT be
        subtracted again. Subtracting them a second time undercounts what the
        date is carrying and lets a returning customer with the same cart, and
        therefore the same hold id, reserve pieces that somebody else has
        already bought. The Supabase statement sketched at the foot of this
        file has no such subtraction, which is the behaviour to match.
      */
      const committed = livePieces(state, input.bakeDate, input.now);
      const remainingBefore = Math.max(0, input.capacityPieces - Math.max(0, committed));
      if (input.pieces > remainingBefore) {
        return { ok: false, reason: "sold-out", remainingPieces: remainingBefore };
      }

      const hold: CapacityHold = {
        holdId: input.holdId,
        bakeDate: input.bakeDate,
        pieces: input.pieces,
        expiresAt: input.expiresAt,
        confirmed: false,
        orderRef: input.orderRef,
      };
      state.holds.set(hold.holdId, hold);
      return { ok: true, hold, remainingPieces: remainingBefore - input.pieces, reused: false };
    },

    async releaseHold(holdId) {
      const hold = state.holds.get(holdId);
      // A confirmed hold belongs to a paid order and is never released here.
      if (hold === undefined || hold.confirmed) return;
      state.holds.delete(holdId);
    },

    async confirmHold(holdId, orderRef, now) {
      const hold = state.holds.get(holdId);
      if (hold === undefined) return false;
      /*
        An unconfirmed hold that is past its expiry stopped counting against
        the date the moment it lapsed, so the pieces it was holding may
        already have been sold to somebody else. Confirm it anyway, because
        the order is paid and the pieces are real, but report that there was
        no live hold so the caller flags the date for a human. Answering true
        here is how a bake day gets quietly oversold: it is exactly the case
        the caller is watching for.
      */
      const wasLive = hold.confirmed || hold.expiresAt > now;
      state.holds.set(holdId, { ...hold, confirmed: true, orderRef });
      return wasLive;
    },

    async beginEvent(eventId, now) {
      const seen = state.events.get(eventId);
      if (seen?.state === "done") return "done";
      /*
        An in-flight claim belongs to a process that is part way through the
        event, or to one that died holding it. A function that is killed on a
        timeout leaves the second kind behind, and a claim nobody ever
        releases is a paid order that is never recorded. So a claim older
        than STALE_CLAIM_MS is taken over rather than believed.
      */
      if (seen?.state === "in-flight" && now - seen.at < STALE_CLAIM_MS) return "in-flight";
      state.events.set(eventId, { state: "in-flight", at: now });
      return "fresh";
    },

    async completeEvent(eventId) {
      state.events.set(eventId, { state: "done", at: Date.now() });
    },

    async failEvent(eventId) {
      /*
        Deleted rather than marked done, so that Stripe's retry of an event
        this process failed halfway through is treated as new work. An event
        that is marked done after a failure is an order that never happens
        and nobody ever hears about.
      */
      state.events.delete(eventId);
    },

    async recordOrder(order) {
      state.orders.set(order.sessionId, order);
    },

    async findOrderBySession(sessionId) {
      return state.orders.get(sessionId) ?? null;
    },

    async recordConsent(record) {
      state.consents.push(record);
    },

    async flag(flag) {
      state.flags.push(flag);
    },

    async saveSubscriber(subscriber) {
      const key = subscriber.email.toLowerCase();
      if (state.subscribers.has(key)) return "existing";
      state.subscribers.set(key, subscriber);
      return "created";
    },

    async capTotalCents(year, timeZone) {
      let total = 0;
      for (const order of state.orders.values()) {
        if (order.status !== "paid") continue;
        const createdAt = new Date(order.createdAt);
        // An unreadable timestamp cannot be filed under any year. Skipping it
        // is what the previous UTC comparison did too, and a thrown error
        // inside a webhook would be worse than a figure that is short by one
        // order Hakop can see in the admin.
        if (Number.isNaN(createdAt.getTime())) continue;
        if (calendarYearIn(createdAt, timeZone) !== year) continue;
        total += order.capContributionCents;
      }
      return total;
    },
  };
}

/*
  One shared instance for the running process, so that two functions in the
  same warm container see the same holds. Tests build their own with
  createMemoryOrderStore() and never touch this.
*/
let processStore: MemoryOrderStore | null = null;

export function defaultOrderStore(): OrderStore {
  processStore ??= createMemoryOrderStore();
  return processStore;
}

/*
  WHAT THE SUPABASE IMPLEMENTATION MUST DO
  ========================================

  It implements OrderStore above and nothing else. Four tables and two
  behaviours carry all the weight.

  1. capacity_holds
       hold_id text primary key,
       bake_date date not null,
       pieces integer not null check (pieces > 0),
       expires_at timestamptz not null,
       confirmed boolean not null default false,
       order_ref text not null,
       created_at timestamptz not null default now()
     index on (bake_date) where confirmed or expires_at > now()

     reserve() is ONE statement inside ONE transaction, and it must be the
     check and the write together:

       insert into capacity_holds (hold_id, bake_date, pieces, expires_at, order_ref)
       select $1, $2, $3, $4, $5
       where coalesce((
         select sum(pieces) from capacity_holds
         where bake_date = $2 and (confirmed or expires_at > now())
       ), 0) + $3 <= $6
       on conflict (hold_id) do nothing;

     Zero rows inserted means sold out, unless the hold id already exists and
     is still live, which is the retry case and succeeds. Read the row back
     in the same transaction to tell the two apart. Doing this as a select
     then an insert reintroduces exactly the race this exists to close.

     On that retry case, push expires_at out to the new value when it is
     later and the row is not confirmed. Each retry creates a session with a
     later expiry, and the hold must outlive every session it backs.

     confirmHold sets confirmed on the row and returns whether that row was
     still LIVE, which is `confirmed or expires_at > now()` read in the same
     statement:

       update capacity_holds
          set confirmed = true, order_ref = $2
        where hold_id = $1
       returning (confirmed or expires_at > now()) as was_live;

     No row, or was_live false, is a paid order whose capacity had already
     gone back to the date, and the webhook flags it. Returning true just
     because a row was updated hides an oversold bake day.

  2. orders
       order_ref text primary key,
       stripe_session_id text unique not null,
       payment_intent_id text,
       status text not null,
       bake_date date not null,
       mode text not null,
       zip text,
       lines jsonb not null,
       pieces_total integer not null,
       amount_total_cents integer not null,
       amount_tax_cents integer not null,
       cap_contribution_cents integer not null,
       customer_email text,
       created_at timestamptz not null default now()

     recordOrder is an upsert on stripe_session_id. The webhook can be
     delivered twice and the second delivery must not create a second order.

  3. webhook_events
       event_id text primary key,
       state text not null check (state in ('in-flight','done')),
       claimed_at timestamptz not null default now()

     beginEvent is `insert ... on conflict (event_id) do nothing returning *`.
     A returned row means this process owns the event. No row means somebody
     else has it: read the state to decide between in-flight and done. An
     in-flight row older than five minutes belongs to a process that died and
     is reclaimed by updating claimed_at in the same statement, exactly as
     the memory implementation above does.

  4. consent_records, admin_flags, subscribers
       Append only. consent_records is evidence: no update, no delete, and
       the statement is stored as text rather than as a reference to a
       version table, because the point is to prove what the customer read
       even after the wording changes.

     subscribers has a unique index on lower(email).

  Credentials: the service role key, and only in a function. This module is
  never imported by page code. Row level security denies everything to the
  anon key on all five tables.
*/
