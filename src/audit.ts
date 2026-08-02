/**
 * Audit-row writer (CONVENTIONS.md A3, TOOLS.md §7).
 *
 * Two call sites, deliberately:
 *   - Success path: called INSIDE the same transaction as the mutation it records,
 *     so a mutation can never commit without its audit row.
 *   - Rejection path: called standalone after the transaction aborted, because a
 *     rolled-back transaction would take the rejection row with it.
 *
 * Scope note: `execute_resolution` rejections are audited. `propose_resolution`
 * rejections are not — they are validation outcomes, not blocked mutations, and are
 * logged at `warn` instead. See CONVENTIONS.md A3.
 *
 * Populated in Phase 4.
 */
import type { Db } from "./db/queries.js";

export type AuditOutcome = "success" | `rejected:${string}`;

export interface AuditRow {
  timestamp: string;
  /** Client-asserted, NOT authenticated. 'unattributed' when absent (A2.1). */
  actor: string;
  tool: string;
  proposal_id: string | null;
  action: string;
  target_id: string;
  amount_cents: number | null;
  /** JSON snapshot taken before the mutation. */
  before_state: string;
  /** JSON snapshot taken after. Equal to before_state on rejections. */
  after_state: string;
  outcome: AuditOutcome;
}

/** Inserts one append-only audit row and returns its rowid. */
export function writeAuditRow(_db: Db, _row: AuditRow): number {
  throw new Error("writeAuditRow is not implemented yet — see PLAN.md Phase 4");
}
