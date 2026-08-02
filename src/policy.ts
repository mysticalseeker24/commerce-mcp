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
 * Populated in Phase 4; tests are written first (PLAN.md Tier 1).
 */

/** $150.00. The client's stated per-refund ceiling. Boundary: 15000 passes, 15001 fails. */
export const REFUND_CAP_CENTS = 15_000;

/** Boundary: exactly 30 days passes, 31 fails. */
export const MAX_ORDER_AGE_DAYS = 30;

/** Strictly below. risk_score 69 passes, 70 fails. */
export const RISK_SCORE_THRESHOLD = 70;

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

export function evaluateRefundEligibility(): EligibilityResult {
  throw new Error("evaluateRefundEligibility is not implemented yet — see PLAN.md Phase 4");
}
