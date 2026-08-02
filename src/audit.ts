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
 */
import type { Db, Queries } from "./db/queries.js";
import { now } from "./time.js";

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
  action_key: string | null;
  /** JSON snapshot taken before the mutation. */
  before_state: string;
  /** JSON snapshot taken after. Equal to before_state on rejections. */
  after_state: string;
  outcome: AuditOutcome;
}

/**
 * The state an audit row captures.
 *
 * Deterministic field order and sorted arrays, because these snapshots are compared
 * as strings for the staleness check — a differing key order would read as a
 * differing state.
 */
export interface StateSnapshot {
  order: { id: string; status: string; total_cents: number };
  payments: Array<{ id: string; status: string; amount_cents: number; refunded_cents: number }>;
  holds: Array<{ id: string; status: string; qty: number }>;
}

export function captureState(queries: Queries, orderId: string): StateSnapshot {
  const order = queries.getOrder(orderId);
  if (order === undefined) throw new Error(`captureState: unknown order ${orderId}`);

  return {
    order: { id: order.id, status: order.status, total_cents: order.total_cents },
    payments: queries
      .getPaymentsForOrder(orderId)
      .map((p) => ({
        id: p.id,
        status: p.status,
        amount_cents: p.amount_cents,
        refunded_cents: p.refunded_cents,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    holds: queries
      .getHoldsForOrder(orderId)
      .map((h) => ({ id: h.id, status: h.status, qty: h.qty }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Holds are in the snapshot even though SPEC §3 calls the column
 * `order_state_snapshot` "order+payments": ORD-1004-style hold changes would
 * otherwise slip past the staleness guard entirely.
 */
export function serializeState(snapshot: StateSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Inserts one append-only audit row and returns its rowid. */
export function writeAuditRow(db: Db, row: AuditRow): number {
  const result = db
    .prepare(
      `INSERT INTO audit_log
         (timestamp, actor, tool, proposal_id, action, target_id, amount_cents,
          action_key, before_state, after_state, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.timestamp, row.actor, row.tool, row.proposal_id, row.action, row.target_id,
      row.amount_cents, row.action_key, row.before_state, row.after_state, row.outcome,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Record a refused execution.
 *
 * `action_key` is deliberately NULL on rejections. The partial unique index covers
 * `outcome = 'success'` only, but writing the key on a rejection would still be a
 * lie: nothing was reserved, and a later legitimate retry must be free to use it.
 */
export function writeRejection(
  db: Db,
  params: {
    actor: string;
    tool: string;
    proposalId: string | null;
    action: string;
    targetId: string;
    amountCents: number | null;
    state: string;
    reason: string;
  },
): number {
  return writeAuditRow(db, {
    timestamp: now(),
    actor: params.actor,
    tool: params.tool,
    proposal_id: params.proposalId,
    action: params.action,
    target_id: params.targetId,
    amount_cents: params.amountCents,
    action_key: null,
    before_state: params.state,
    after_state: params.state,
    outcome: `rejected:${params.reason}`,
  });
}
