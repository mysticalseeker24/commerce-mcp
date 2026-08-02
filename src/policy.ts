/**
 * Refund eligibility engine.
 *
 * The client's execution scope: gated execution is appropriate only for an eligible
 * order refund. Six conjunctive checks — ALL must pass. Order matters: `first_failure`
 * reports the earliest failing check, which is what the analyst reads.
 *
 * This is a blast-radius control (CONVENTIONS.md A1), not a convenience: it is the
 * difference between "the agent may issue refunds" and "the agent may issue refunds
 * that satisfy six independently verifiable conditions."
 *
 * Evaluated twice, deliberately — at propose time for the analyst's benefit, and
 * again at execute time. Execute NEVER trusts the proposal's stored verdict.
 *
 * Pure: no database access, no clock reads except the injectable `now`. That is what
 * makes every branch testable without constructing a scenario in SQL.
 */
import type {
  CarrierExceptionRow,
  CustomerRow,
  OrderRow,
  PaymentRow,
} from "./db/queries.js";
import { formatCents } from "./money.js";

/** $150.00. The client's stated per-refund ceiling. Boundary: 15000 passes, 15001 fails. */
export const REFUND_CAP_CENTS = 15_000;

/** Boundary: exactly 30 days passes, 31 fails. */
export const MAX_ORDER_AGE_DAYS = 30;

/** Strictly below. risk_score 69 passes, 70 fails. */
export const RISK_SCORE_THRESHOLD = 70;

const MS_PER_DAY = 86_400_000;

/** Evaluation order is the SPEC §4.4 order; `first_failure` depends on it. */
export const CHECK_IDS = [
  "amount_within_cap",
  "amount_within_paid",
  "order_within_age",
  "customer_risk_below_threshold",
  "verified_carrier_exception",
  "no_duplicate_refund",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export interface EligibilityCheck {
  id: CheckId;
  label: string;
  passed: boolean;
  /**
   * Short human-readable justification, e.g. "risk_score 30 < 70" or
   * "carrier exception CE-004 (return_received) verified 2026-07-24".
   * This is what makes the policy auditable rather than merely enforced.
   */
  evidence: string;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  /** id of the earliest failing check, or null when eligible. */
  first_failure: CheckId | null;
}

export interface EligibilityInput {
  order: OrderRow;
  /** The payment the refund would be taken from. */
  payment: PaymentRow;
  customer: CustomerRow;
  carrierExceptions: CarrierExceptionRow[];
  /** action_keys of refunds already executed successfully anywhere in the system. */
  priorRefundActionKeys: string[];
  amountCents: number;
  /** Injectable clock, so age boundaries are testable. */
  now?: Date;
}

/**
 * Canonical identity of a refund action: `refund:<order_id>:<carrier_exception_id>`.
 *
 * Defining "same action" this precisely is what lets ORD-1007's earlier, unrelated
 * partial refund coexist with a legitimate carrier-exception refund on the same
 * order without falsely tripping `no_duplicate_refund`. Uniquely indexed on
 * executed rows, so idempotency is enforced by the database rather than by a check.
 */
export function buildActionKey(orderId: string, carrierExceptionId: string): string {
  return `refund:${orderId}:${carrierExceptionId}`;
}

/** Cents still available to refund against a payment. */
export function refundableCents(payment: PaymentRow): number {
  return Math.max(payment.amount_cents - payment.refunded_cents, 0);
}

/** The verified carrier exception justifying a refund, if one exists. */
export function verifiedCarrierException(
  exceptions: readonly CarrierExceptionRow[],
): CarrierExceptionRow | undefined {
  return exceptions.find((ce) => ce.verified === 1);
}

function daysBetween(fromIso: string, to: Date): number {
  return (to.getTime() - new Date(fromIso).getTime()) / MS_PER_DAY;
}

/**
 * Run all six checks. Every check is evaluated even after one fails — the analyst
 * needs the whole picture to decide what to escalate, not just the first problem.
 */
export function evaluateRefundEligibility(input: EligibilityInput): EligibilityResult {
  const { order, payment, customer, carrierExceptions, priorRefundActionKeys, amountCents } = input;
  const now = input.now ?? new Date();

  const refundable = refundableCents(payment);
  const ageDays = daysBetween(order.created_at, now);
  const exception = verifiedCarrierException(carrierExceptions);
  const actionKey = exception === undefined ? null : buildActionKey(order.id, exception.id);
  const duplicate = actionKey !== null && priorRefundActionKeys.includes(actionKey);

  const checks: EligibilityCheck[] = [
    {
      id: "amount_within_cap",
      label: `Amount within the ${formatCents(REFUND_CAP_CENTS)} cap`,
      passed: amountCents <= REFUND_CAP_CENTS,
      evidence:
        amountCents <= REFUND_CAP_CENTS
          ? `${formatCents(amountCents)} is within the ${formatCents(REFUND_CAP_CENTS)} per-resolution cap`
          : `${formatCents(amountCents)} exceeds the ${formatCents(REFUND_CAP_CENTS)} per-resolution cap`,
    },
    {
      id: "amount_within_paid",
      label: "Amount does not exceed what remains refundable",
      passed: amountCents <= refundable,
      evidence:
        amountCents <= refundable
          ? `${formatCents(amountCents)} is within the ${formatCents(refundable)} still refundable on ${payment.id}`
          : `${formatCents(amountCents)} exceeds the ${formatCents(refundable)} still refundable on ${payment.id}` +
            ` (${formatCents(payment.amount_cents)} captured, ${formatCents(payment.refunded_cents)} already refunded)`,
    },
    {
      id: "order_within_age",
      label: `Order placed within ${MAX_ORDER_AGE_DAYS} days`,
      passed: ageDays <= MAX_ORDER_AGE_DAYS,
      evidence: `order is ${ageDays.toFixed(1)} days old (limit ${MAX_ORDER_AGE_DAYS})`,
    },
    {
      id: "customer_risk_below_threshold",
      label: `Customer risk score below ${RISK_SCORE_THRESHOLD}`,
      passed: customer.risk_score < RISK_SCORE_THRESHOLD,
      evidence:
        customer.risk_score < RISK_SCORE_THRESHOLD
          ? `risk_score ${customer.risk_score} < ${RISK_SCORE_THRESHOLD}`
          : `risk_score ${customer.risk_score} >= ${RISK_SCORE_THRESHOLD}`,
    },
    {
      id: "verified_carrier_exception",
      label: "A verified carrier exception is on file",
      passed: exception !== undefined,
      evidence:
        exception === undefined
          ? carrierExceptions.length === 0
            ? "no carrier exception recorded for this order"
            : `${carrierExceptions.length} carrier exception(s) on file, none verified` +
              ` (${carrierExceptions.map((ce) => `${ce.id} ${ce.type}`).join(", ")})`
          : `carrier exception ${exception.id} (${exception.type}) verified` +
            `${exception.verified_at === null ? "" : ` ${exception.verified_at.slice(0, 10)}`}` +
            ` via ${exception.source}`,
    },
    {
      id: "no_duplicate_refund",
      label: "No refund already executed for this same action",
      passed: !duplicate,
      evidence:
        actionKey === null
          ? "no action key — requires a verified carrier exception first"
          : duplicate
            ? `a refund with action key ${actionKey} has already been executed`
            : `no prior refund carries action key ${actionKey}`,
    },
  ];

  const firstFailure = checks.find((c) => !c.passed);

  return {
    eligible: firstFailure === undefined,
    checks,
    first_failure: firstFailure?.id ?? null,
  };
}
