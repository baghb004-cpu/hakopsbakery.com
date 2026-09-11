/**
 * Bake days, cutoffs and capacity.
 *
 * Pure logic. No DOM, no environment reads, no network, no imports. It runs
 * in the browser inside the fulfillment island, in Node inside the
 * check-availability function, and at build time. Everything it needs arrives
 * as an argument.
 *
 * Nothing in this file describes how gata is made. The batch size is a
 * capacity number Hakop sets in configuration, the same way a shop sets how
 * many tables it has. It is never derived from a recipe and it is never
 * written down here.
 *
 * ---------------------------------------------------------------------
 * WHY THE DATE HANDLING LOOKS LIKE THIS
 * ---------------------------------------------------------------------
 *
 * A bake day is a calendar date in Cypress, California, and an order cutoff
 * is a wall clock time in Cypress, California. Neither is an instant, and
 * neither survives a trip through the browser's local timezone.
 *
 * The customer may be in Sacramento, but they may also be checking the site
 * from a phone still set to New York, and the Netlify function answering them
 * runs in UTC. If any of those three derives "today" from its own clock, a
 * customer in one timezone sees a different set of bake dates than the same
 * customer would see an hour later, and the sold out date they picked turns
 * into a checkout error, which is the exact failure the brief calls the
 * cheapest thing a store can do.
 *
 * So: every date in this module is a civil date string, YYYY-MM-DD, in the
 * shop's timezone. Two conversions cross the boundary between civil dates and
 * instants, and both go through Intl.DateTimeFormat with an explicit timeZone
 * rather than through the host's local time.
 *
 * Daylight saving is the other half of it. America/Los_Angeles has two days a
 * year that are not twenty four hours long. Adding 86400000 milliseconds to
 * an instant to get "tomorrow" is wrong twice a year, and it is wrong in the
 * direction that silently drops or repeats a bake day. Calendar arithmetic
 * here is done in UTC, where every day really is twenty four hours, and only
 * the final civil date is read back out. Wall clock times (the cutoff) are
 * resolved to an instant by round trip: guess, format the guess back into the
 * zone, and keep the candidate that reproduces the time asked for.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A civil calendar date in the shop timezone, formatted YYYY-MM-DD. */
export type IsoDate = string;

/** 0 Sunday through 6 Saturday, matching Date.prototype.getDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const TUESDAY: Weekday = 2;

/**
 * Weekdays that can never be bake days, whatever a pattern or an override
 * says. Hakop is in class Tuesdays, 8am to 3pm. This is not configuration: a
 * pattern that asked for Tuesday would be a mistake, and the schedule refuses
 * it rather than offering a date he cannot bake.
 */
export const NEVER_BAKE_WEEKDAYS: readonly Weekday[] = [TUESDAY];

/**
 * Default only. Callers should pass commerce.timezone from @config/site so
 * there is one place to change it.
 */
export const SHOP_TIME_ZONE = "America/Los_Angeles";

/** How far ahead the picker looks when the caller does not say. */
export const DEFAULT_HORIZON_DAYS = 28;

export const BAKE_DATE_STATUSES = [
  "open",
  "sold-out",
  "past-cutoff",
  "blackout",
] as const;

export type BakeDateStatus = (typeof BAKE_DATE_STATUSES)[number];

/**
 * Short labels, so the picker, the cart and the admin all use one wording.
 * A caller wanting a longer sentence can write its own; it should not invent
 * a different short one.
 */
export const BAKE_DATE_STATUS_LABELS: Readonly<Record<BakeDateStatus, string>> = {
  open: "Open",
  "sold-out": "Sold out",
  "past-cutoff": "Ordering closed",
  blackout: "Not baking",
};

/**
 * How many batches Hakop can commit to on each weekday he bakes.
 *
 * A weekday that is absent, or set to zero, is not a bake day. Expressing the
 * pattern as batches rather than as a list of days means the weekly rhythm
 * and the weekly ceiling are one number in one place: a Saturday worth four
 * batches and a Wednesday worth two is the normal shape of this business.
 */
export interface WeeklyAvailability {
  readonly batchesByWeekday: Readonly<Partial<Record<Weekday, number>>>;
}

/**
 * Orders for a bake date close at `hour`:`minute` local time, `daysBefore`
 * calendar days before that date. The default configuration is hour 20 and
 * daysBefore 2, so a Saturday bake closes Thursday at 8pm.
 */
export interface CutoffRule {
  readonly hour: number;
  /** Optional. Defaults to the top of the hour. */
  readonly minute?: number;
  readonly daysBefore: number;
}

/**
 * One line of a committed order, in the units the customer actually bought.
 *
 * piecesPerUnit comes from the catalog variant, not from this module. A tray
 * and a half tray hold different numbers of pieces, and only the catalog
 * knows which is which.
 */
export interface OrderLine {
  readonly qty: number;
  readonly piecesPerUnit: number;
}

/** An order already committed to a bake date. Paid, or held in checkout. */
export interface CommittedOrder {
  readonly bakeDate: IsoDate;
  readonly lines: readonly OrderLine[];
}

export interface BakeScheduleConfig {
  /** IANA zone. Pass commerce.timezone. */
  readonly timeZone: string;
  readonly availability: WeeklyAvailability;
  readonly cutoff: CutoffRule;
  /**
   * How many pieces one batch produces. A CONFIGURATION value, set by Hakop
   * in the admin and passed in from there. Never hardcoded, never inferred.
   */
  readonly piecesPerBatch: number;
  /** Dates Hakop is not baking: travel, holidays, a full week off. */
  readonly blackoutDates?: readonly string[];
  /**
   * Per date batch ceilings that win over the weekly pattern. A positive
   * number opens a date that the pattern does not cover, or resizes one it
   * does. Zero closes a date. Tuesday still loses.
   */
  readonly dateOverrides?: Readonly<Record<string, number>>;
  /** Calendar days ahead to offer, counting today. */
  readonly horizonDays?: number;
}

export interface BakeCapacity {
  readonly batchCeiling: number;
  readonly piecesPerBatch: number;
  /** batchCeiling * piecesPerBatch. */
  readonly capacityPieces: number;
  readonly committedPieces: number;
  /** Never negative, even if a date was oversold by hand. */
  readonly remainingPieces: number;
  /** Batches the committed pieces have already claimed. */
  readonly batchesCommitted: number;
}

export interface BakeDate {
  readonly date: IsoDate;
  readonly weekday: Weekday;
  readonly status: BakeDateStatus;
  /** True only when status is open. The one field a picker needs. */
  readonly selectable: boolean;
  readonly capacity: BakeCapacity;
  /** The instant ordering closes, ISO 8601 in UTC. Format it in timeZone. */
  readonly cutoffAt: string;
}

export interface BakeSchedule {
  readonly timeZone: string;
  /** Today's civil date in timeZone, not in the caller's local time. */
  readonly today: IsoDate;
  /** The instant this answer was computed, so a stale cache is visible. */
  readonly generatedAt: string;
  readonly dates: readonly BakeDate[];
}

export interface BuildScheduleInput {
  readonly config: BakeScheduleConfig;
  readonly orders?: readonly CommittedOrder[];
  /** Pin the clock. Tests and server code should always pass this. */
  readonly now?: Date;
  /**
   * Keep blackout, sold out and past cutoff dates in the result so the picker
   * can show them greyed out with a reason. Default true: a date that
   * silently vanishes reads as a bug, and "sold out" is information a
   * customer wants.
   */
  readonly includeUnavailable?: boolean;
}

/* ------------------------------------------------------------------ */
/* Timezone primitives                                                 */
/* ------------------------------------------------------------------ */

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/*
  Constructing an Intl.DateTimeFormat is one of the more expensive things in
  the standard library, and the schedule builder formats several times per
  candidate date. One formatter per zone, kept for the life of the module,
  turns that cost into nothing. The cache is keyed by zone and holds no state
  beyond the formatter itself, so the module stays pure.
*/
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // h23 rather than hour12:false. Older engines answer "24" for midnight
    // under hour12:false, which would quietly push a cutoff a day out.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

/** What a clock on the wall in timeZone reads at this instant. */
function wallPartsAt(instantMs: number, timeZone: string): WallParts {
  const parts = wallFormatter(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new RangeError(`Time zone ${timeZone} produced no ${type} part.`);
    }
    return Number.parseInt(found.value, 10);
  };
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Belt and braces against an engine that still says 24 for midnight.
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds, positive
 * east of Greenwich. This is the only honest way to ask the question: an
 * offset is a property of an instant, not of a zone, because it changes twice
 * a year.
 */
function offsetMsAt(instantMs: number, timeZone: string): number {
  // Offsets are whole minutes, so aligning to the second keeps the
  // subtraction exact without losing anything.
  const aligned = Math.floor(instantMs / 1000) * 1000;
  const wall = wallPartsAt(aligned, timeZone);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asIfUtc - aligned;
}

function wallMatches(
  instantMs: number,
  wanted: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): boolean {
  const actual = wallPartsAt(instantMs, timeZone);
  return (
    actual.year === wanted.year &&
    actual.month === wanted.month &&
    actual.day === wanted.day &&
    actual.hour === wanted.hour &&
    actual.minute === wanted.minute
  );
}

/**
 * Turn a wall clock time in a zone into a real instant.
 *
 * Method: pretend the wall time is UTC, ask the zone what its offset was at
 * that rough instant, shift by it, then check the answer by formatting it
 * back. If it reproduces the time asked for, it is right. If it does not, the
 * first guess landed on the wrong side of a daylight saving transition, so
 * try again with the offset from the corrected instant.
 *
 * Two days a year have an awkward answer:
 *
 * Fall back. 1:30am happens twice. Both candidates round trip and we return
 * the first one, the earlier of the two, which is the usual convention and
 * the one that closes ordering sooner rather than later.
 *
 * Spring forward. 2:30am does not happen at all. Neither candidate round
 * trips, and we return the instant the clock jumps to, which is later than
 * the time asked for. A cutoff that quietly moved earlier would refuse orders
 * that were placed in good time, so later is the safe direction to err.
 *
 * In practice the cutoff is 8pm and neither case can be reached. The
 * correctness still matters: someone will change the hour one day, and a
 * function that is only right for the hours nobody chose is a trap.
 */
export function instantForWallTime(
  date: IsoDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const { year, month, day } = parseCalendarDate(date);
  const wanted = { year, month, day, hour, minute };
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  const first = asIfUtc - offsetMsAt(asIfUtc, timeZone);
  if (wallMatches(first, wanted, timeZone)) return new Date(first);

  const second = asIfUtc - offsetMsAt(first, timeZone);
  if (wallMatches(second, wanted, timeZone)) return new Date(second);

  return new Date(first);
}

/* ------------------------------------------------------------------ */
/* Civil calendar helpers                                              */
/* ------------------------------------------------------------------ */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** Shape check plus a real date check, so 2026-02-30 is refused. */
export function isCalendarDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * Throws on anything that is not a real YYYY-MM-DD. Internal callers only:
 * values that reach this have already been through isCalendarDate, and a
 * throw here means a bug rather than a bad request.
 */
export function parseCalendarDate(date: IsoDate): {
  year: number;
  month: number;
  day: number;
} {
  if (!isCalendarDate(date)) {
    throw new RangeError(`Not a calendar date: ${JSON.stringify(date)}`);
  }
  const match = CALENDAR_DATE.exec(date);
  // isCalendarDate already proved the shape; this is for the type checker.
  if (match === null) throw new RangeError(`Not a calendar date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Today's civil date in the shop timezone, not in the caller's. */
export function toCalendarDate(instant: Date, timeZone: string): IsoDate {
  const wall = wallPartsAt(instant.getTime(), timeZone);
  return `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/**
 * Civil date arithmetic, done in UTC on purpose.
 *
 * A UTC day is always exactly 86400000 milliseconds because UTC has no
 * daylight saving, so stepping through dates there and reading back only the
 * calendar fields is exact. Doing the same arithmetic on a local timestamp
 * would land on 1am or 11pm of the right day twice a year, and occasionally
 * on the wrong day entirely. The calendar itself is identical in every zone,
 * which is what makes this safe: the day after 2026-03-07 is 2026-03-08
 * everywhere, transition or not.
 */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseCalendarDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return `${pad4(shifted.getUTCFullYear())}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

/**
 * Which weekday a civil date falls on. Timezone independent: a date's weekday
 * is a property of the calendar, so UTC is as good an answer as any zone.
 */
export function weekdayOf(date: IsoDate): Weekday {
  const { year, month, day } = parseCalendarDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

/** Sorts and compares civil dates. Lexical order is chronological here. */
export function compareCalendarDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Bake days                                                           */
/* ------------------------------------------------------------------ */

/** Tuesday is class day. Nothing overrides it. */
export function isNeverBakeWeekday(weekday: Weekday): boolean {
  return NEVER_BAKE_WEEKDAYS.includes(weekday);
}

/**
 * The batch ceiling for one date: the weekly pattern, unless a per date
 * override says otherwise, and always zero on a Tuesday.
 *
 * Zero means the date is not a bake day and never appears in the schedule.
 */
export function batchCeilingFor(date: IsoDate, config: BakeScheduleConfig): number {
  const weekday = weekdayOf(date);
  if (isNeverBakeWeekday(weekday)) return 0;

  const override = config.dateOverrides?.[date];
  const fromPattern = config.availability.batchesByWeekday[weekday] ?? 0;
  const ceiling = override ?? fromPattern;

  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;
  // A fractional ceiling is a configuration slip. Round down, because
  // promising a batch that cannot be baked is worse than offering one fewer.
  return Math.floor(ceiling);
}

/* ------------------------------------------------------------------ */
/* Cutoff                                                              */
/* ------------------------------------------------------------------ */

/** The instant ordering closes for a given bake date. */
export function cutoffInstantFor(
  date: IsoDate,
  cutoff: CutoffRule,
  timeZone: string,
): Date {
  const closesOn = addCalendarDays(date, -cutoff.daysBefore);
  return instantForWallTime(closesOn, cutoff.hour, cutoff.minute ?? 0, timeZone);
}

/**
 * Has ordering closed for this date?
 *
 * The comparison is instant against instant, which is the only comparison
 * that is the same answer everywhere. At exactly the cutoff, ordering is
 * closed: the customer who hits submit on the stroke of eight is late, and
 * the alternative is a race Hakop loses in his own kitchen.
 */
export function isPastCutoff(
  date: IsoDate,
  cutoff: CutoffRule,
  timeZone: string,
  now: Date,
): boolean {
  return now.getTime() >= cutoffInstantFor(date, cutoff, timeZone).getTime();
}

/* ------------------------------------------------------------------ */
/* Pieces and batches                                                  */
/* ------------------------------------------------------------------ */

/*
  Order quantities arrive in whatever unit the customer bought, and capacity
  is counted in pieces, so everything converts to pieces first and back to
  batches last.

  These throw on data that is not a finite number rather than treating it as
  zero. A broken row silently counted as zero oversells a bake day, and an
  oversold day is a phone call to a customer on a Friday night. A thrown error
  makes the availability call fail loudly, the picker shows an error, and
  Hakop finds out before a stranger does.
*/

function requireFinite(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, received ${String(value)}.`);
  }
  return value;
}

/** Pieces in one order line. Negative quantities count as nothing. */
export function piecesInLine(line: OrderLine): number {
  const qty = requireFinite(line.qty, "OrderLine.qty");
  const per = requireFinite(line.piecesPerUnit, "OrderLine.piecesPerUnit");
  if (qty <= 0 || per <= 0) return 0;
  // Rounded up, so a half unit still claims a whole piece of capacity.
  // Rounding up can only ever leave a little capacity unsold. Rounding down
  // sells capacity that does not exist.
  return Math.ceil(qty * per);
}

export function piecesInOrder(order: CommittedOrder): number {
  return order.lines.reduce((total, line) => total + piecesInLine(line), 0);
}

/**
 * Total committed pieces per bake date.
 *
 * Orders naming a date that is not a valid civil date are dropped: they
 * cannot match any date in the schedule, so counting them would only hide
 * capacity. Everything else is trusted and summed.
 */
export function piecesByBakeDate(
  orders: readonly CommittedOrder[],
): ReadonlyMap<IsoDate, number> {
  const totals = new Map<IsoDate, number>();
  for (const order of orders) {
    if (!isCalendarDate(order.bakeDate)) continue;
    const running = totals.get(order.bakeDate) ?? 0;
    totals.set(order.bakeDate, running + piecesInOrder(order));
  }
  return totals;
}

/**
 * Convenience for callers whose database already aggregates pieces per date
 * and that have no line detail to hand.
 */
export function orderFromPieces(bakeDate: IsoDate, pieces: number): CommittedOrder {
  return { bakeDate, lines: [{ qty: pieces, piecesPerUnit: 1 }] };
}

/** How many batches a piece count occupies. */
export function batchesForPieces(pieces: number, piecesPerBatch: number): number {
  assertPiecesPerBatch(piecesPerBatch);
  if (pieces <= 0) return 0;
  return Math.ceil(pieces / piecesPerBatch);
}

function assertPiecesPerBatch(piecesPerBatch: number): void {
  if (!Number.isFinite(piecesPerBatch) || piecesPerBatch <= 0) {
    throw new RangeError(
      "piecesPerBatch must be a positive number. It is a configuration value " +
        "and there is no safe default to fall back to.",
    );
  }
}

/**
 * Capacity for one date.
 *
 * The ceiling is counted in batches because the constraint is real work: a
 * batch is one pass through the kitchen, and there are only so many in a day.
 * Selling is counted in pieces, because that is what a customer buys.
 *
 * The two meet in a way worth stating plainly. A date closes when its pieces
 * run out, not when the last batch is opened. If the ceiling is three batches
 * and two and a bit are spoken for, the rest of that third batch is still for
 * sale: it is going in regardless, and refusing the last few pieces of a
 * batch that is already committed would turn Hakop's own capacity against
 * him. Once every piece of every allowed batch is claimed, the date is shut.
 */
export function capacityFor(
  date: IsoDate,
  config: BakeScheduleConfig,
  committedPieces: number,
): BakeCapacity {
  assertPiecesPerBatch(config.piecesPerBatch);
  const piecesPerBatch = Math.floor(config.piecesPerBatch);
  const batchCeiling = batchCeilingFor(date, config);
  const capacityPieces = batchCeiling * piecesPerBatch;
  const committed = Math.max(0, Math.ceil(committedPieces));
  return {
    batchCeiling,
    piecesPerBatch,
    capacityPieces,
    committedPieces: committed,
    remainingPieces: Math.max(0, capacityPieces - committed),
    batchesCommitted: batchesForPieces(committed, piecesPerBatch),
  };
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * Precedence, and why it is this way round.
 *
 * blackout first: Hakop is not in the kitchen that day, so nothing else about
 * the date is true or interesting.
 *
 * past cutoff next: once ordering has closed, whether the date also happened
 * to sell out is history. "Ordering closed" is the fact the customer can act
 * on, by picking a later date.
 *
 * sold out last, and it is the only one of the three that might change back,
 * because an abandoned checkout releases its pieces.
 */
export function bakeDateStatus(input: {
  readonly date: IsoDate;
  readonly config: BakeScheduleConfig;
  readonly capacity: BakeCapacity;
  readonly isBlackout: boolean;
  readonly now: Date;
}): BakeDateStatus {
  if (input.isBlackout) return "blackout";
  if (isPastCutoff(input.date, input.config.cutoff, input.config.timeZone, input.now)) {
    return "past-cutoff";
  }
  if (input.capacity.remainingPieces <= 0) return "sold-out";
  return "open";
}

/* ------------------------------------------------------------------ */
/* The schedule                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every candidate bake date from today to the end of the horizon, each with a
 * status and the numbers behind it.
 *
 * Dates that are not bake days at all (a weekday Hakop does not bake, and
 * every Tuesday) are absent rather than listed as closed. There is no reason
 * to show a customer a Tuesday.
 */
export function buildBakeSchedule(input: BuildScheduleInput): BakeSchedule {
  const { config } = input;
  assertPiecesPerBatch(config.piecesPerBatch);

  const now = input.now ?? new Date();
  const timeZone = config.timeZone;
  const today = toCalendarDate(now, timeZone);
  const horizon = Math.max(1, Math.floor(config.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const includeUnavailable = input.includeUnavailable ?? true;

  const blackouts = new Set(
    (config.blackoutDates ?? []).filter((value): value is IsoDate => isCalendarDate(value)),
  );
  const committed = piecesByBakeDate(input.orders ?? []);

  const dates: BakeDate[] = [];
  for (let offset = 0; offset < horizon; offset += 1) {
    const date = addCalendarDays(today, offset);
    if (batchCeilingFor(date, config) <= 0) continue;

    const capacity = capacityFor(date, config, committed.get(date) ?? 0);
    const status = bakeDateStatus({
      date,
      config,
      capacity,
      isBlackout: blackouts.has(date),
      now,
    });
    if (status !== "open" && !includeUnavailable) continue;

    dates.push({
      date,
      weekday: weekdayOf(date),
      status,
      selectable: status === "open",
      capacity,
      cutoffAt: cutoffInstantFor(date, config.cutoff, timeZone).toISOString(),
    });
  }

  return {
    timeZone,
    today,
    generatedAt: now.toISOString(),
    dates,
  };
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export function selectableBakeDates(schedule: BakeSchedule): readonly BakeDate[] {
  return schedule.dates.filter((entry) => entry.selectable);
}

/** The soonest date a customer can actually order, or null if there is none. */
export function nextOpenBakeDate(schedule: BakeSchedule): BakeDate | null {
  return schedule.dates.find((entry) => entry.selectable) ?? null;
}

/** Look one date up, for validating a bake date that came back from a form. */
export function findBakeDate(schedule: BakeSchedule, date: unknown): BakeDate | null {
  if (!isCalendarDate(date)) return null;
  return schedule.dates.find((entry) => entry.date === date) ?? null;
}

/**
 * Server side guard for checkout. The browser sends a date string; this says
 * whether that date is genuinely open right now, computed from the same rules
 * the picker used. Section 8 of the architecture doc: the browser is never
 * the authority on availability.
 */
export function isBakeDateSelectable(schedule: BakeSchedule, date: unknown): boolean {
  return findBakeDate(schedule, date)?.selectable === true;
}
