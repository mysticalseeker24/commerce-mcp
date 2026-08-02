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
  source: string;
  created_at: string;
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

  return {
    db,
    getOrder: (orderId) => selectOrder.get(orderId),
    getCustomer: (customerId) => selectCustomer.get(customerId),
    getPaymentsForOrder: (orderId) => selectPayments.all(orderId),
    getHoldsForOrder: (orderId) => selectHolds.all(orderId),
    getEventsForOrder: (orderId) => selectEvents.all(orderId),
    getCarrierExceptionsForOrder: (orderId) => selectCarrierExceptions.all(orderId),
    countOrders: () => selectOrderCount.get()?.c ?? 0,
  };
}
