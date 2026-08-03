-- DDL for all 10 tables. Verbatim from SPEC.md §3.
--
-- CONVENTIONS.md B2: schema changes go here and nowhere else. seed.ts executes
-- this file and then inserts; it never contains DDL of its own.
--
-- Money is integer cents (USD) throughout. Timestamps are ISO-8601 UTC strings
-- computed relative to boot time in seed.ts, never hardcoded.

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS escalations;
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS inventory_holds;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS carrier_exceptions;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,          -- CUST-0001
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  risk_score  INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 99),
  created_at  TEXT NOT NULL
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,         -- ORD-1001
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  status       TEXT NOT NULL CHECK (status IN
               ('pending','confirmed','packed','shipped','delivered','cancelled','failed')),
  total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at   TEXT NOT NULL,
  notes        TEXT                      -- UNTRUSTED customer-authored text
);

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,         -- PAY-2001
  order_id     TEXT NOT NULL REFERENCES orders(id),
  gateway_ref  TEXT NOT NULL,            -- e.g. ch_XXXX (synthetic)
  status       TEXT NOT NULL CHECK (status IN
               ('initiated','authorized','captured','failed','refund_initiated','refunded')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- Cents committed to refunds against this payment, settled OR in flight.
  -- SPEC's refundable_cents is "captured minus already refunded/initiated", so an
  -- initiated-but-unsettled refund counts here too (see ORD-1003).
  -- A partial refund must be representable: the product's one executable action
  -- refunds $30.00 against a $200.00 capture, and a status flip alone would imply
  -- the whole $200.00 came back.
  refunded_cents INTEGER NOT NULL DEFAULT 0
                 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  method       TEXT NOT NULL,            -- card | ach | paypal | wallet
  created_at   TEXT NOT NULL
);
-- Processor state is READ-ONLY to this product. Nothing here is ever mutated by a
-- tool except the one eligible-refund branch of execute_resolution, which
-- increments refunded_cents rather than overwriting status.

CREATE TABLE carrier_exceptions (
  id          TEXT PRIMARY KEY,          -- CE-001
  order_id    TEXT NOT NULL REFERENCES orders(id),
  type        TEXT NOT NULL CHECK (type IN
              ('return_received','lost_in_transit','damaged_on_arrival','delivery_failed')),
  verified    INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  -- Value of goods this exception accounts for. Structured rather than parsed out
  -- of event prose: this figure drives discrepancy_cents and therefore the refund
  -- amount, so it must not depend on how a sentence was worded.
  claim_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (claim_value_cents >= 0),
  source      TEXT NOT NULL,             -- carrier/system that reported it
  created_at  TEXT NOT NULL
);
-- A verified row here is eligibility check 5. Unverified rows exist on healthy
-- orders so that check has a genuine negative case, not just an absent one.

CREATE TABLE inventory (
  sku          TEXT PRIMARY KEY,         -- SKU-XXXX
  product_name TEXT NOT NULL,
  total_stock  INTEGER NOT NULL,
  reserved     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE inventory_holds (
  id         TEXT PRIMARY KEY,           -- HOLD-3001
  order_id   TEXT NOT NULL REFERENCES orders(id),
  sku        TEXT NOT NULL REFERENCES inventory(sku),
  qty        INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active','released','consumed')),
  created_at TEXT NOT NULL
);

CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  timestamp  TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('orders','payments','inventory','fulfillment')),
  event_type TEXT NOT NULL,              -- e.g. payment_captured, hold_created, packed
  detail     TEXT NOT NULL               -- human-readable sentence
);
-- Load-bearing table: get_order_timeline is SELECT ... WHERE order_id = ? ORDER BY timestamp.
-- Every seeded scenario seeds its full event history here.

CREATE TABLE escalations (
  id          TEXT PRIMARY KEY,          -- ESC-<uuid>
  order_id    TEXT NOT NULL REFERENCES orders(id),
  proposal_id TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('human_review','manager_approval')),
  reason      TEXT NOT NULL,             -- duplicate_charge_suspected, refund_ineligible, …
  evidence    TEXT NOT NULL,             -- JSON packet, auto-assembled (never free-text-only)
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at  TEXT NOT NULL
);
-- kind mirrors the client's wording: duplicate charges → human_review;
-- ineligible refunds and all non-refund actions → manager_approval.

CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,        -- PROP-<uuid>
  order_id      TEXT NOT NULL REFERENCES orders(id),
  action        TEXT NOT NULL CHECK (action IN ('refund','escalate')),
  target_id     TEXT NOT NULL,           -- payment/hold/order the action applies to
  amount_cents  INTEGER,                 -- required for refund actions
  action_key    TEXT,                    -- refund:<order_id>:<carrier_exception_id>
  -- The escalation classification the ANALYST CONFIRMED. execute_resolution reads
  -- these rather than re-deriving, so the escalation that gets filed is provably
  -- the one shown in the plan. Re-deriving let propose and execute disagree.
  escalation_kind   TEXT CHECK (escalation_kind IN ('human_review','manager_approval')),
  escalation_reason TEXT,
  reasoning     TEXT NOT NULL,           -- the AI's stated justification, stored verbatim
  order_state_snapshot TEXT NOT NULL,    -- JSON of order+payments+holds at proposal time
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','executed','rejected','expired')),
  created_at    TEXT NOT NULL
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL,
  actor        TEXT NOT NULL,            -- client-asserted; 'unattributed' if absent
  tool         TEXT NOT NULL,
  proposal_id  TEXT,
  action       TEXT NOT NULL CHECK (action IN ('refund','escalate')),
  target_id    TEXT NOT NULL,
  amount_cents INTEGER,
  action_key   TEXT,                     -- refund:<order_id>:<carrier_exception_id>
  before_state TEXT NOT NULL,            -- JSON snapshot
  after_state  TEXT NOT NULL,            -- JSON snapshot
  outcome      TEXT NOT NULL             -- success | rejected:<reason>
);

-- Idempotency is enforced by the database, not by a check: at most one SUCCESSFUL
-- refund may exist per action_key. The partial predicate matters — without the
-- outcome clause, one rejected attempt would occupy the key and permanently block
-- the legitimate retry.
CREATE UNIQUE INDEX audit_log_action_key_executed
  ON audit_log(action_key)
  WHERE action_key IS NOT NULL AND outcome = 'success';

-- Read-path indexes. get_order_timeline and search_orders are the hot queries.
CREATE INDEX order_events_order_id_timestamp ON order_events(order_id, timestamp);
CREATE INDEX payments_order_id ON payments(order_id);
CREATE INDEX inventory_holds_order_id ON inventory_holds(order_id);
CREATE INDEX inventory_holds_sku_status ON inventory_holds(sku, status);
CREATE INDEX carrier_exceptions_order_id ON carrier_exceptions(order_id);
CREATE INDEX escalations_order_id ON escalations(order_id);
CREATE INDEX audit_log_order_target ON audit_log(target_id);
-- search_orders pages with a (created_at, id) row-value keyset comparison.
CREATE INDEX orders_created_at_id ON orders(created_at DESC, id DESC);
CREATE INDEX orders_customer_id ON orders(customer_id);
