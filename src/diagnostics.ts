/**
 * Diagnostics: the arithmetic and the flag rules behind get_order_timeline.
 *
 * "The tool does the arithmetic; the agent does the judgment" (TOOLS.md tool 2).
 * Every figure an agent might quote in a proposal is computed here, so no number in
 * the product is invented by a language model.
 *
 * Pure — rows in, diagnostics out. Same testability argument as policy.ts.
 */
import type {
  CarrierExceptionRow,
  HoldRow,
  OrderEventRow,
  OrderRow,
  PaymentRow,
} from "./db/queries.js";

export const FLAGS = [
  "DOUBLE_CHARGE_SUSPECTED",
  "CAPTURED_BUT_FAILED",
  "REFUND_STUCK",
  "ORPHANED_HOLD",
  "CONFIRMED_UNPAID",
  "FULFILLMENT_STALLED",
  "PARTIAL_REFUND_GAP",
] as const;

export type Flag = (typeof FLAGS)[number];

const MS_PER_DAY = 86_400_000;

/** Days with no fulfillment progress before FULFILLMENT_STALLED fires. */
const STALL_THRESHOLD_DAYS = 3;

/**
 * Order states from which an inventory hold can never be consumed.
 *
 * Deliberately excludes `failed`: a failed order can still be confirmed and go on
 * to consume its hold, which is exactly ORD-1001's remedy. ORPHANED_HOLD means
 * "held against an order that will never ship", not "held against an unhappy
 * order" — see WORKLOG entry 8.
 */
const TERMINAL_FOR_HOLDS = new Set(["cancelled"]);

export interface MoneyDiagnostics {
  captured_total_cents: number;
  refunded_total_cents: number;
  net_paid_cents: number;
  order_total_cents: number;
  /**
   * How much more the customer is out of pocket than they should be.
   * Positive = the customer has paid more than they owe.
   */
  discrepancy_cents: number;
}

export interface DiagnosticsInput {
  order: OrderRow;
  payments: readonly PaymentRow[];
  holds: readonly HoldRow[];
  events: readonly OrderEventRow[];
  carrierExceptions: readonly CarrierExceptionRow[];
  now?: Date;
}

export function computeMoney(
  order: OrderRow,
  payments: readonly PaymentRow[],
  returnedValueCents = 0,
): MoneyDiagnostics {
  const captured = payments
    .filter((p) => p.status === "captured" || p.status === "refunded" || p.status === "refund_initiated")
    .reduce((sum, p) => sum + p.amount_cents, 0);

  const refunded = payments.reduce((sum, p) => sum + p.refunded_cents, 0);
  const netPaid = captured - refunded;

  // What the customer SHOULD have paid, once returns are accounted for.
  const owed = Math.max(order.total_cents - returnedValueCents, 0);

  return {
    captured_total_cents: captured,
    refunded_total_cents: refunded,
    net_paid_cents: netPaid,
    order_total_cents: order.total_cents,
    discrepancy_cents: netPaid - owed,
  };
}

/**
 * Value of goods accounted for by VERIFIED carrier exceptions.
 *
 * Read from `carrier_exceptions.claim_value_cents`, never parsed out of event prose.
 * An earlier attempt scraped dollar amounts from `detail` strings and got two things
 * wrong at once: the amount lives on a different event type per scenario, and
 * ORD-1009 records it on two events, so the parse double-counted. This figure drives
 * `discrepancy_cents` and therefore the refund amount — it must not depend on how a
 * sentence happened to be worded.
 *
 * Unverified exceptions contribute nothing: an unconfirmed claim is not a debt.
 */
export function returnedValueCents(exceptions: readonly CarrierExceptionRow[]): number {
  return exceptions
    .filter((ce) => ce.verified === 1)
    .reduce((sum, ce) => sum + ce.claim_value_cents, 0);
}

/**
 * Days since the most recent event, to one decimal place.
 *
 * One decimal rather than a floor, to match how policy.ts states order age
 * ("order is 2.0 days old"). Reporting `1` alongside `2.0` for the same order
 * invites the reader to wonder which one is rounded and in which direction.
 */
export function daysSinceLastEvent(events: readonly OrderEventRow[], now: Date): number {
  const last = events.at(-1);
  if (last === undefined) return 0;
  const days = (now.getTime() - new Date(last.timestamp).getTime()) / MS_PER_DAY;
  return Math.round(days * 10) / 10;
}

/**
 * The flag rule engine. Each rule states the failure class it recognises; an order
 * can legitimately raise more than one.
 */
export function computeFlags(input: DiagnosticsInput, money: MoneyDiagnostics): Flag[] {
  const { order, payments, holds, events } = input;
  const now = input.now ?? new Date();
  const flags: Flag[] = [];

  const captured = payments.filter((p) => p.status === "captured");

  // Two or more successful captures against one order.
  if (captured.length > 1) flags.push("DOUBLE_CHARGE_SUSPECTED");

  // Money taken, order in a failed state.
  if (order.status === "failed" && captured.length > 0) flags.push("CAPTURED_BUT_FAILED");

  // Refund started and never settled.
  if (payments.some((p) => p.status === "refund_initiated")) flags.push("REFUND_STUCK");

  // Inventory held against an order that will never ship.
  if (TERMINAL_FOR_HOLDS.has(order.status) && holds.some((h) => h.status === "active")) {
    flags.push("ORPHANED_HOLD");
  }

  // Order advanced past checkout with no money actually collected.
  const advanced = order.status === "confirmed" || order.status === "packed" || order.status === "shipped";
  if (advanced && money.net_paid_cents <= 0) flags.push("CONFIRMED_UNPAID");

  // Paid and packed, then silence.
  if (order.status === "packed" && daysSinceLastEvent(events, now) >= STALL_THRESHOLD_DAYS) {
    flags.push("FULFILLMENT_STALLED");
  }

  // The customer is owed money the system has not returned.
  if (money.discrepancy_cents > 0 && !flags.includes("DOUBLE_CHARGE_SUSPECTED")) {
    flags.push("PARTIAL_REFUND_GAP");
  }

  return flags;
}

export interface Diagnostics extends MoneyDiagnostics {
  flags: Flag[];
  days_since_last_event: number;
}

export function computeDiagnostics(input: DiagnosticsInput): Diagnostics {
  const now = input.now ?? new Date();
  const returned = returnedValueCents(input.carrierExceptions);
  const money = computeMoney(input.order, input.payments, returned);
  return {
    ...money,
    flags: computeFlags(input, money),
    days_since_last_event: daysSinceLastEvent(input.events, now),
  };
}
