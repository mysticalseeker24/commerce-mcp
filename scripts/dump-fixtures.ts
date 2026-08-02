/**
 * Prints ORD-1001…ORD-1011 as a readable dump for the Phase 1 manual review gate.
 *
 * The invariant tests check what I thought to encode; this exists so a human can
 * check what I didn't. Run with: npx tsx scripts/dump-fixtures.ts
 */
import { createDb, SEED_VERSION } from "../src/db/seed.js";
import { createQueries } from "../src/db/queries.js";
import { FIXTURES } from "../src/db/fixtures.js";
import { formatCents } from "../src/money.js";
import { MAX_ORDER_AGE_DAYS, REFUND_CAP_CENTS, RISK_SCORE_THRESHOLD } from "../src/policy.js";

const db = createDb(":memory:");
const q = createQueries(db);

const MS_PER_DAY = 86_400_000;
const ageDays = (iso: string): string =>
  ((Date.now() - new Date(iso).getTime()) / MS_PER_DAY).toFixed(1);

const line = (char = "─"): string => char.repeat(78);

console.log(`\nSEED_VERSION ${SEED_VERSION}   ·   ${q.countOrders()} orders total`);
console.log(
  `policy: cap ${formatCents(REFUND_CAP_CENTS)} · age ≤${MAX_ORDER_AGE_DAYS}d · risk <${RISK_SCORE_THRESHOLD}`,
);

for (const fixture of FIXTURES) {
  const order = q.getOrder(fixture.id);
  if (order === undefined) throw new Error(`${fixture.id} missing from the seed`);
  const customer = q.getCustomer(order.customer_id);
  const payments = q.getPaymentsForOrder(fixture.id);
  const holds = q.getHoldsForOrder(fixture.id);
  const exceptions = q.getCarrierExceptionsForOrder(fixture.id);
  const events = q.getEventsForOrder(fixture.id);

  console.log(`\n${line("═")}`);
  console.log(`${fixture.id}  ${fixture.scenario}`);
  console.log(`EXPECTED: ${fixture.expected_outcome}`);
  console.log(line());

  console.log(
    `order      status=${order.status}  total=${formatCents(order.total_cents)}  age=${ageDays(order.created_at)}d`,
  );
  console.log(
    `customer   ${customer?.id} ${customer?.name}  risk_score=${customer?.risk_score}` +
      `${(customer?.risk_score ?? 0) >= RISK_SCORE_THRESHOLD ? "  ← FAILS risk check" : ""}`,
  );

  const captured = payments
    .filter((p) => p.status === "captured")
    .reduce((sum, p) => sum + p.amount_cents, 0);
  for (const p of payments) {
    console.log(
      `payment    ${p.id}  ${p.status.padEnd(16)} ${formatCents(p.amount_cents).padStart(10)}  ${p.method}  ${p.gateway_ref}`,
    );
  }
  if (payments.length > 1) {
    console.log(
      `           captured total ${formatCents(captured)} vs order total ${formatCents(order.total_cents)}` +
        `  → discrepancy ${formatCents(captured - order.total_cents)}`,
    );
  }

  for (const h of holds) {
    const flag = h.status === "active" && (order.status === "cancelled" || order.status === "failed")
      ? "  ← ORPHANED"
      : "";
    console.log(`hold       ${h.id}  ${h.sku}  qty=${h.qty}  ${h.status}${flag}`);
  }

  if (exceptions.length === 0) {
    console.log(`carrier    (none) ← FAILS verified_carrier_exception`);
  }
  for (const ce of exceptions) {
    console.log(
      `carrier    ${ce.id}  ${ce.type}  verified=${ce.verified === 1}` +
        `${ce.verified_at === null ? "" : `  at ${ce.verified_at.slice(0, 10)}`}  src=${ce.source}`,
    );
  }

  if (order.notes !== null) {
    console.log(`notes      ⚠ UNTRUSTED: ${JSON.stringify(order.notes)}`);
  }

  console.log(`events     (${events.length})`);
  for (const e of events) {
    console.log(
      `  ${e.timestamp.slice(0, 16).replace("T", " ")}  ${e.source.padEnd(12)} ${e.event_type.padEnd(22)} ${e.detail}`,
    );
  }
}

console.log(`\n${line("═")}`);
console.log("Cross-check — inventory.reserved vs sum(active holds):");
const reserved = db
  .prepare<[], { sku: string; product_name: string; total_stock: number; reserved: number }>(
    "SELECT sku, product_name, total_stock, reserved FROM inventory WHERE reserved > 0 ORDER BY sku",
  )
  .all();
for (const r of reserved) {
  console.log(`  ${r.sku}  ${r.product_name.padEnd(30)} stock=${r.total_stock}  reserved=${r.reserved}`);
}

db.close();
