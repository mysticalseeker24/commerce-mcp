/**
 * Every SQL statement in the project lives here, as a named prepared statement.
 *
 * CONVENTIONS.md B2 — hard rules:
 *   - Tools never contain SQL strings.
 *   - No string interpolation into SQL, ever. Prepared-statement parameter binding
 *     is what prevents injection here; Zod prevents malformed input, which is a
 *     different problem (CONVENTIONS.md A1).
 *
 * Statements are prepared once per connection and reused. Read tools land in
 * Phases 2–3, write tools in Phase 4; this module grows with them.
 */
import type BetterSqlite3 from "better-sqlite3";

export type Db = BetterSqlite3.Database;

/* --------------------------------------------------------------------------
 * Row types. Hand-written because they mirror schema.sql, which TypeScript
 * cannot infer from. Every column is listed so a schema change that isn't
 * reflected here shows up as a type error at the call site.
 * -------------------------------------------------------------------------- */

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  risk_score: number;
  created_at: string;
}

export interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  total_cents: number;
  created_at: string;
  notes: string | null;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  gateway_ref: string;
  status: string;
  amount_cents: number;
  /** Cents committed to refunds, settled or in flight. refundable = amount - this. */
  refunded_cents: number;
  method: string;
  created_at: string;
}

export interface HoldRow {
  id: string;
  order_id: string;
  sku: string;
  qty: number;
  status: string;
  created_at: string;
}

export interface InventoryRow {
  sku: string;
  product_name: string;
  total_stock: number;
  reserved: number;
}

export interface OrderEventRow {
  id: number;
  order_id: string;
  timestamp: string;
  source: string;
  event_type: string;
  detail: string;
}

export interface CarrierExceptionRow {
  id: string;
  order_id: string;
  type: string;
  verified: number;
  verified_at: string | null;
  claim_value_cents: number;
  source: string;
  created_at: string;
}

export interface AuditRowRead {
  id: number;
  timestamp: string;
  actor: string;
  tool: string;
  proposal_id: string | null;
  action: string;
  target_id: string;
  amount_cents: number | null;
  action_key: string | null;
  before_state: string;
  after_state: string;
  outcome: string;
}

/** Filters for search_orders. `null` means "not filtering on this". */
export interface OrderSearchFilters {
  order_id: string | null;
  customer_email: string | null;
  status: string | null;
  created_after: string | null;
  created_before: string | null;
  min_amount_cents: number | null;
  max_amount_cents: number | null;
}

/** Keyset cursor: the (created_at, id) of the last row already returned. */
export interface OrderSearchCursor {
  created_at: string;
  id: string;
}

export interface Queries {
  readonly db: Db;
  getOrder(orderId: string): OrderRow | undefined;
  getCustomer(customerId: string): CustomerRow | undefined;
  getPaymentsForOrder(orderId: string): PaymentRow[];
  getHoldsForOrder(orderId: string): HoldRow[];
  getEventsForOrder(orderId: string): OrderEventRow[];
  getCarrierExceptionsForOrder(orderId: string): CarrierExceptionRow[];
  countOrders(): number;
  /**
   * action_keys of refunds that actually executed. Feeds eligibility check 6.
   * Filtered to successful rows, matching the partial unique index — a rejected
   * attempt must not permanently block the legitimate retry.
   */
  getExecutedRefundActionKeys(): string[];

  /** Keyset page of orders matching `filters`, newest first. */
  searchOrders(
    filters: OrderSearchFilters,
    cursor: OrderSearchCursor | null,
    limit: number,
  ): OrderRow[];
  /** Total matching `filters`, ignoring the cursor and limit. */
  countMatchingOrders(filters: OrderSearchFilters): number;

  getPayment(paymentId: string): PaymentRow | undefined;
  getInventory(sku: string): InventoryRow | undefined;
  getHoldsForSku(sku: string): HoldRow[];
  getAuditLog(orderId: string | null, limit: number): AuditRowRead[];

  /* ---- write path (Phase 4) --------------------------------------------- */
  insertProposal(row: ProposalRow): void;
  getProposal(proposalId: string): ProposalRow | undefined;
  /**
   * The concurrency guard. Conditional on `status = 'pending'`, so of two
   * simultaneous callers exactly one sees a changed row.
   * @returns rows affected: 1 = this caller won, 0 = already executed or unknown.
   */
  claimProposal(proposalId: string): number;
  markProposalExpired(proposalId: string): void;
  /** Adds to `refunded_cents`; never overwrites `status`. */
  applyRefund(paymentId: string, amountCents: number): void;
  appendEvent(orderId: string, timestamp: string, source: string, eventType: string, detail: string): void;
  insertEscalation(row: EscalationRow): void;
}

export interface ProposalRow {
  id: string;
  order_id: string;
  action: string;
  target_id: string;
  amount_cents: number | null;
  action_key: string | null;
  escalation_kind: string | null;
  escalation_reason: string | null;
  reasoning: string;
  order_state_snapshot: string;
  status: string;
  created_at: string;
}

export interface EscalationRow {
  id: string;
  order_id: string;
  proposal_id: string | null;
  kind: string;
  reason: string;
  evidence: string;
  created_at: string;
}

export function createQueries(db: Db): Queries {
  const selectOrder = db.prepare<[string], OrderRow>("SELECT * FROM orders WHERE id = ?");
  const selectCustomer = db.prepare<[string], CustomerRow>("SELECT * FROM customers WHERE id = ?");
  const selectPayments = db.prepare<[string], PaymentRow>(
    "SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, id",
  );
  const selectHolds = db.prepare<[string], HoldRow>(
    "SELECT * FROM inventory_holds WHERE order_id = ? ORDER BY id",
  );
  const selectEvents = db.prepare<[string], OrderEventRow>(
    "SELECT * FROM order_events WHERE order_id = ? ORDER BY timestamp, id",
  );
  const selectCarrierExceptions = db.prepare<[string], CarrierExceptionRow>(
    "SELECT * FROM carrier_exceptions WHERE order_id = ? ORDER BY id",
  );
  const selectOrderCount = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM orders");
  const selectExecutedRefundKeys = db.prepare<[], { action_key: string }>(
    "SELECT action_key FROM audit_log WHERE action_key IS NOT NULL AND outcome = 'success'",
  );

  /* ------------------------------------------------------------------------
   * search_orders.
   *
   * The filter list is variable but the SQL is NOT: every optional filter uses a
   * `:param IS NULL OR ...` guard, so this stays one statically-prepared statement
   * with named parameters. Composing a WHERE clause from string fragments would
   * have worked too, but a single static statement keeps CONVENTIONS B2's "all SQL
   * lives here as named prepared statements" literally true, and leaves no code
   * path where a fragment could ever be built from input.
   *
   * Pagination is keyset, using SQLite row-value comparison:
   *     (created_at, id) < (:cursor_created_at, :cursor_id)
   * Comparing the tuple rather than `created_at < ?` is what makes ties safe.
   * Verified by mutation: replacing this with a naive `created_at <` comparison
   * silently loses 5 of 250 orders across a full sweep.
   * ---------------------------------------------------------------------- */
  const ORDER_FILTER_SQL = `
    (:order_id IS NULL OR o.id = :order_id)
    AND (:customer_email IS NULL OR c.email = :customer_email)
    AND (:status IS NULL OR o.status = :status)
    AND (:created_after IS NULL OR o.created_at >= :created_after)
    AND (:created_before IS NULL OR o.created_at <= :created_before)
    AND (:min_amount_cents IS NULL OR o.total_cents >= :min_amount_cents)
    AND (:max_amount_cents IS NULL OR o.total_cents <= :max_amount_cents)
  `;

  const selectOrderPage = db.prepare<Record<string, string | number | null>, OrderRow>(`
    SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE ${ORDER_FILTER_SQL}
      AND (:cursor_created_at IS NULL
           OR (o.created_at, o.id) < (:cursor_created_at, :cursor_id))
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT :limit
  `);

  const selectMatchingOrderCount = db.prepare<Record<string, string | number | null>, { c: number }>(`
    SELECT COUNT(*) AS c FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE ${ORDER_FILTER_SQL}
  `);

  const selectPayment = db.prepare<[string], PaymentRow>("SELECT * FROM payments WHERE id = ?");
  const selectInventory = db.prepare<[string], InventoryRow>(
    "SELECT * FROM inventory WHERE sku = ?",
  );
  const selectHoldsForSku = db.prepare<[string], HoldRow>(
    "SELECT * FROM inventory_holds WHERE sku = ? ORDER BY id",
  );
  const selectAuditAll = db.prepare<[number], AuditRowRead>(
    "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?",
  );
  const selectAuditForOrder = db.prepare<[string, string, number], AuditRowRead>(
    `SELECT a.* FROM audit_log a
     WHERE a.target_id = ?
        OR a.target_id IN (SELECT id FROM payments WHERE order_id = ?)
     ORDER BY a.id DESC LIMIT ?`,
  );

  /* ---- write path -------------------------------------------------------- */
  const insertProposalStmt = db.prepare(
    `INSERT INTO proposals
       (id, order_id, action, target_id, amount_cents, action_key,
        escalation_kind, escalation_reason, reasoning,
        order_state_snapshot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectProposal = db.prepare<[string], ProposalRow>("SELECT * FROM proposals WHERE id = ?");
  // THE concurrency guard. Two callers, one winner — enforced by the WHERE clause,
  // not by application logic that could be reordered or forgotten.
  const claimProposalStmt = db.prepare<[string]>(
    "UPDATE proposals SET status = 'executed' WHERE id = ? AND status = 'pending'",
  );
  const expireProposalStmt = db.prepare<[string]>(
    "UPDATE proposals SET status = 'expired' WHERE id = ?",
  );
  // Adds to refunded_cents; status is deliberately untouched, so a partial refund
  // against a larger capture never reads as a full one.
  const applyRefundStmt = db.prepare<[number, string]>(
    "UPDATE payments SET refunded_cents = refunded_cents + ? WHERE id = ?",
  );
  const insertEventStmt = db.prepare<[string, string, string, string, string]>(
    "INSERT INTO order_events (order_id, timestamp, source, event_type, detail) VALUES (?, ?, ?, ?, ?)",
  );
  const insertEscalationStmt = db.prepare(
    `INSERT INTO escalations (id, order_id, proposal_id, kind, reason, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const filterParams = (f: OrderSearchFilters): Record<string, string | number | null> => ({
    order_id: f.order_id,
    customer_email: f.customer_email,
    status: f.status,
    created_after: f.created_after,
    created_before: f.created_before,
    min_amount_cents: f.min_amount_cents,
    max_amount_cents: f.max_amount_cents,
  });

  return {
    db,
    getOrder: (orderId) => selectOrder.get(orderId),
    getCustomer: (customerId) => selectCustomer.get(customerId),
    getPaymentsForOrder: (orderId) => selectPayments.all(orderId),
    getHoldsForOrder: (orderId) => selectHolds.all(orderId),
    getEventsForOrder: (orderId) => selectEvents.all(orderId),
    getCarrierExceptionsForOrder: (orderId) => selectCarrierExceptions.all(orderId),
    countOrders: () => selectOrderCount.get()?.c ?? 0,
    getExecutedRefundActionKeys: () => selectExecutedRefundKeys.all().map((r) => r.action_key),

    searchOrders: (filters, cursor, limit) =>
      selectOrderPage.all({
        ...filterParams(filters),
        cursor_created_at: cursor?.created_at ?? null,
        cursor_id: cursor?.id ?? null,
        limit,
      }),

    countMatchingOrders: (filters) => selectMatchingOrderCount.get(filterParams(filters))?.c ?? 0,

    getPayment: (paymentId) => selectPayment.get(paymentId),
    getInventory: (sku) => selectInventory.get(sku),
    getHoldsForSku: (sku) => selectHoldsForSku.all(sku),
    getAuditLog: (orderId, limit) =>
      orderId === null
        ? selectAuditAll.all(limit)
        : selectAuditForOrder.all(orderId, orderId, limit),

    insertProposal: (row) => {
      insertProposalStmt.run(
        row.id, row.order_id, row.action, row.target_id, row.amount_cents,
        row.action_key, row.escalation_kind, row.escalation_reason, row.reasoning,
        row.order_state_snapshot, row.status, row.created_at,
      );
    },
    getProposal: (proposalId) => selectProposal.get(proposalId),
    claimProposal: (proposalId) => claimProposalStmt.run(proposalId).changes,
    markProposalExpired: (proposalId) => {
      expireProposalStmt.run(proposalId);
    },
    applyRefund: (paymentId, amountCents) => {
      applyRefundStmt.run(amountCents, paymentId);
    },
    appendEvent: (orderId, timestamp, source, eventType, detail) => {
      insertEventStmt.run(orderId, timestamp, source, eventType, detail);
    },
    insertEscalation: (row) => {
      insertEscalationStmt.run(
        row.id, row.order_id, row.proposal_id, row.kind, row.reason, row.evidence, row.created_at,
      );
    },
  };
}
