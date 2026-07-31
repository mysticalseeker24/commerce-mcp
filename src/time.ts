/**
 * Clock. CONVENTIONS.md B1: ISO-8601 UTC strings everywhere, and one module owns
 * `now()` plus boot-relative offsets so tests can control time.
 *
 * SPEC.md §2.1: seeded timestamps are computed relative to boot, never hardcoded —
 * a "stuck for 4 days" scenario has to still be stuck when an evaluator opens it
 * next week.
 */

/** Captured once, at process start. T0 for every seeded scenario. */
const BOOT_TIME = new Date();

export type IsoTimestamp = string;

export function toIso(date: Date): IsoTimestamp {
  return date.toISOString();
}

/** Boot instant — the T0 that seed scenarios offset from. */
export function bootTime(): Date {
  return new Date(BOOT_TIME);
}

export function bootTimeIso(): IsoTimestamp {
  return toIso(BOOT_TIME);
}

/** Wall-clock now. Everything user-facing (`as_of`, audit rows) uses this. */
export function now(): IsoTimestamp {
  return toIso(new Date());
}

/** Seconds the process has been up — for `/health`. */
export function uptimeSeconds(): number {
  return Math.floor(process.uptime());
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** `T0 − n days`, as an ISO string. Used throughout seed.ts. */
export function daysAgo(n: number, from: Date = BOOT_TIME): IsoTimestamp {
  return toIso(new Date(from.getTime() - n * MS_PER_DAY));
}

export function hoursAgo(n: number, from: Date = BOOT_TIME): IsoTimestamp {
  return toIso(new Date(from.getTime() - n * MS_PER_HOUR));
}

export function minutesAgo(n: number, from: Date = BOOT_TIME): IsoTimestamp {
  return toIso(new Date(from.getTime() - n * MS_PER_MINUTE));
}

/** Whole days between an ISO timestamp and now — feeds `days_since_last_event`. */
export function daysSince(iso: IsoTimestamp, reference: Date = new Date()): number {
  return Math.floor((reference.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}
