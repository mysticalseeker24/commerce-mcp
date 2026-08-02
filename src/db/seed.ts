/**
 * Deterministic seed. Drops and rebuilds the database on every boot (SPEC.md §4).
 *
 * Zero randomness: healthy orders come from templates driven by a fixed-seed PRNG,
 * and the eleven broken scenarios (ORD-1001…ORD-1011) are hand-written fixtures in
 * fixtures.ts. Those eleven are load-bearing — tests and the demo script depend on
 * their exact IDs, states, amounts, and event histories.
 *
 * Production and tests share this one path (`createDb(':memory:')` in tests), so the
 * suite verifies the real fixtures rather than a parallel set of mocks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Db } from "./queries.js";
import { FIXTURES, type Offset } from "./fixtures.js";
import { bootTime } from "../time.js";
import { formatCents } from "../money.js";

/** Bumped whenever the fixtures change. Surfaced by /health. */
export const SEED_VERSION = "2.0.0";

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/* --------------------------------------------------------------------------
 * Deterministic PRNG. mulberry32 with a fixed seed — no Math.random anywhere in
 * this project, so two boots produce byte-identical healthy orders.
 * -------------------------------------------------------------------------- */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRNG_SEED = 0x5eed_1007;

interface Rng {
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  next(): number;
}

function makeRng(seed: number): Rng {
  const random = mulberry32(seed);
  const next = (): number => random();
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      // noUncheckedIndexedAccess: the index is always in range, but prove it.
      if (item === undefined) throw new Error("pick() from an empty array");
      return item;
    },
  };
}

/* --------------------------------------------------------------------------
 * Time. Every timestamp is derived from boot (T0), never hardcoded — a "stuck
 * for 4 days" scenario must still be stuck when an evaluator opens it next week.
 * -------------------------------------------------------------------------- */
const MS_PER_HOUR = 3_600_000;

function at(offset: Offset, t0: Date): string {
  return new Date(t0.getTime() - offset.hoursAgo * MS_PER_HOUR).toISOString();
}

function hoursAgoIso(h: number, t0: Date): string {
  return new Date(t0.getTime() - h * MS_PER_HOUR).toISOString();
}

/* --------------------------------------------------------------------------
 * Reference data
 * -------------------------------------------------------------------------- */
const FIRST_NAMES = [
  "Priya", "Rahul", "Ananya", "Vikram", "Sneha", "Arjun", "Kavya", "Rohan",
  "Meera", "Aditya", "Divya", "Karthik", "Ishita", "Nikhil", "Pooja", "Siddharth",
  "Lakshmi", "Aman", "Riya", "Varun",
] as const;

const LAST_NAMES = [
  "Sharma", "Iyer", "Patel", "Reddy", "Nair", "Gupta", "Menon", "Desai",
  "Kulkarni", "Bose", "Chatterjee", "Rao", "Joshi", "Malhotra", "Pillai",
] as const;

const PRODUCTS = [
  "Stainless Steel Water Bottle", "Wireless Earbuds", "Cotton Bedsheet Set",
  "Ceramic Coffee Mug", "Yoga Mat", "LED Desk Lamp", "Bluetooth Speaker",
  "Backpack 25L", "Non-Stick Frying Pan", "Running Shoes",
  "Laptop Sleeve 14in", "Electric Kettle", "Wall Clock", "Table Fan",
  "Notebook Set", "Phone Stand", "Air Purifier Filter", "Cushion Cover Pair",
  "Stainless Steel Lunchbox", "USB-C Cable 2m",
] as const;

const PAYMENT_METHODS = ["card", "ach", "paypal", "wallet"] as const;

/** SPEC.md §4.1 status distribution for healthy orders. */
const HEALTHY_STATUS_WEIGHTS = [
  { status: "delivered", weight: 55 },
  { status: "shipped", weight: 15 },
  { status: "packed", weight: 10 },
  { status: "confirmed", weight: 10 },
  { status: "cancelled", weight: 5 },
  { status: "pending", weight: 5 },
] as const;

function pickHealthyStatus(rng: Rng): (typeof HEALTHY_STATUS_WEIGHTS)[number]["status"] {
  const roll = rng.int(1, 100);
  let cumulative = 0;
  for (const entry of HEALTHY_STATUS_WEIGHTS) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry.status;
  }
  return "delivered";
}

const HEALTHY_ORDER_COUNT = 239;
const CUSTOMER_COUNT = 60;
const SKU_COUNT = 20;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/* --------------------------------------------------------------------------
 * createDb
 * -------------------------------------------------------------------------- */

/**
 * Open a connection, apply schema.sql, and seed it.
 *
 * @param path filesystem path, or ':memory:' for tests.
 */
export function createDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  seed(db);
  return db;
}

function seed(db: Db): void {
  const t0 = bootTime();
  const rng = makeRng(PRNG_SEED);

  const insertCustomer = db.prepare(
    "INSERT INTO customers (id, name, email, risk_score, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertSku = db.prepare(
    "INSERT INTO inventory (sku, product_name, total_stock, reserved) VALUES (?, ?, ?, 0)",
  );
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, customer_id, status, total_cents, created_at, notes) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertPayment = db.prepare(
    "INSERT INTO payments (id, order_id, gateway_ref, status, amount_cents, refunded_cents, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertHold = db.prepare(
    "INSERT INTO inventory_holds (id, order_id, sku, qty, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO order_events (order_id, timestamp, source, event_type, detail) VALUES (?, ?, ?, ?, ?)",
  );
  const insertCarrierException = db.prepare(
    "INSERT INTO carrier_exceptions (id, order_id, type, verified, verified_at, claim_value_cents, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const bumpReserved = db.prepare(
    "UPDATE inventory SET reserved = reserved + ? WHERE sku = ?",
  );

  const seedAll = db.transaction(() => {
    /* ---- customers -------------------------------------------------------- */
    // Fixtures pin risk scores for CUST-0001…CUST-0011; the rest are generated.
    const fixtureRisk = new Map<string, number>(
      FIXTURES.map((f) => [f.customer_id, f.customer_risk_score]),
    );

    for (let i = 1; i <= CUSTOMER_COUNT; i += 1) {
      const id = `CUST-${pad(i, 4)}`;
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
      const pinned = fixtureRisk.get(id);
      // Generated customers stay well clear of the 70 threshold in both directions,
      // so a healthy order never accidentally fails a policy check.
      const risk = pinned ?? rng.int(5, 55);
      insertCustomer.run(id, `${first} ${last}`, email, risk, hoursAgoIso(rng.int(60, 400) * 24, t0));
    }

    /* ---- inventory -------------------------------------------------------- */
    for (let i = 1; i <= SKU_COUNT; i += 1) {
      const name = PRODUCTS[i - 1];
      if (name === undefined) throw new Error(`missing product name at index ${i - 1}`);
      insertSku.run(`SKU-${pad(i, 4)}`, name, rng.int(40, 400));
    }

    /* ---- the 11 broken fixtures ------------------------------------------ */
    for (const fixture of FIXTURES) {
      insertOrder.run(
        fixture.id,
        fixture.customer_id,
        fixture.status,
        fixture.total_cents,
        at(fixture.created, t0),
        fixture.notes,
      );

      for (const payment of fixture.payments) {
        insertPayment.run(
          payment.id,
          fixture.id,
          payment.gateway_ref,
          payment.status,
          payment.amount_cents,
          payment.refunded_cents ?? 0,
          payment.method,
          at(payment.at, t0),
        );
      }

      for (const hold of fixture.holds) {
        insertHold.run(hold.id, fixture.id, hold.sku, hold.qty, hold.status, at(hold.at, t0));
        if (hold.status === "active") bumpReserved.run(hold.qty, hold.sku);
      }

      for (const ce of fixture.carrier_exceptions) {
        insertCarrierException.run(
          ce.id,
          fixture.id,
          ce.type,
          ce.verified ? 1 : 0,
          ce.verified_at === null ? null : at(ce.verified_at, t0),
          ce.claim_value_cents,
          ce.source,
          at(ce.at, t0),
        );
      }

      for (const event of fixture.events) {
        insertEvent.run(fixture.id, at(event.at, t0), event.source, event.event_type, event.detail);
      }
    }

    /* ---- 239 healthy orders ---------------------------------------------- */
    let paymentSeq = 3000;
    let holdSeq = 4000;
    let carrierExceptionSeq = 100;

    for (let i = 1; i <= HEALTHY_ORDER_COUNT; i += 1) {
      const orderId = `ORD-${2000 + i}`;
      const customerId = `CUST-${pad(rng.int(12, CUSTOMER_COUNT), 4)}`;
      const status = pickHealthyStatus(rng);
      // $9.99 – $499.00
      const totalCents = rng.int(999, 49_900);
      const ageHours = rng.int(2, 120 * 24);
      const createdAt = hoursAgoIso(ageHours, t0);
      const sku = `SKU-${pad(rng.int(1, SKU_COUNT), 4)}`;
      const qty = rng.int(1, 3);
      const method = rng.pick(PAYMENT_METHODS);

      insertOrder.run(orderId, customerId, status, totalCents, createdAt, null);

      const paymentId = `PAY-${(paymentSeq += 1)}`;
      const holdId = `HOLD-${(holdSeq += 1)}`;

      // A clean cancellation is a HEALTHY state: refunded payment, released hold.
      const paymentStatus = status === "cancelled" ? "refunded" : status === "pending" ? "authorized" : "captured";
      const holdStatus =
        status === "cancelled" ? "released"
        : status === "pending" || status === "confirmed" ? "active"
        : "consumed";

      // A clean cancellation refunds in full; everything else has nothing refunded.
      const refundedCents = paymentStatus === "refunded" ? totalCents : 0;
      insertPayment.run(
        paymentId, orderId, `ch_${orderId.slice(4)}A`, paymentStatus, totalCents, refundedCents, method, createdAt,
      );
      insertHold.run(holdId, orderId, sku, qty, holdStatus, createdAt);
      if (holdStatus === "active") bumpReserved.run(qty, sku);

      /* Event history — ordered, and always starting with order_created. */
      const events: Array<{ h: number; source: string; type: string; detail: string }> = [
        { h: ageHours, source: "orders", type: "order_created", detail: `Order ${orderId} created for ${formatCents(totalCents)}` },
        { h: ageHours, source: "inventory", type: "hold_created", detail: `Hold ${holdId} placed on ${sku} for ${qty} unit${qty > 1 ? "s" : ""}` },
      ];

      if (paymentStatus === "authorized") {
        events.push({ h: ageHours, source: "payments", type: "payment_authorized", detail: `Payment ${paymentId} authorized for ${formatCents(totalCents)} via ${method}` });
      } else {
        events.push({ h: ageHours, source: "payments", type: "payment_captured", detail: `Payment ${paymentId} captured for ${formatCents(totalCents)} via ${method}` });
      }

      if (status !== "pending") {
        events.push({ h: Math.max(ageHours - 2, 0), source: "orders", type: "order_confirmed", detail: `Order ${orderId} confirmed` });
      }
      if (status === "cancelled") {
        events.push({ h: Math.max(ageHours - 4, 0), source: "orders", type: "order_cancelled", detail: `Order ${orderId} cancelled at customer request` });
        events.push({ h: Math.max(ageHours - 4, 0), source: "inventory", type: "hold_released", detail: `Hold ${holdId} released back to ${sku}` });
        events.push({ h: Math.max(ageHours - 3, 0), source: "payments", type: "refund_completed", detail: `Refund on ${paymentId} settled for ${formatCents(totalCents)}` });
      }
      if (status === "packed" || status === "shipped" || status === "delivered") {
        events.push({ h: Math.max(ageHours - 6, 0), source: "inventory", type: "hold_consumed", detail: `Hold ${holdId} consumed on pick` });
        events.push({ h: Math.max(ageHours - 6, 0), source: "fulfillment", type: "packed", detail: `Order ${orderId} packed` });
      }
      if (status === "shipped" || status === "delivered") {
        events.push({ h: Math.max(ageHours - 12, 0), source: "fulfillment", type: "shipped", detail: `Order ${orderId} shipped` });
      }
      if (status === "delivered") {
        events.push({ h: Math.max(ageHours - 30, 0), source: "fulfillment", type: "delivered", detail: `Order ${orderId} delivered` });
      }

      for (const e of events) {
        insertEvent.run(orderId, hoursAgoIso(e.h, t0), e.source, e.type, e.detail);
      }

      /* An UNVERIFIED carrier exception on roughly every 20th healthy order, so
       * eligibility check 5 has a genuine negative case — an exception that
       * exists but is not verified — rather than merely an absent row. */
      if (status === "delivered" && i % 20 === 0) {
        carrierExceptionSeq += 1;
        insertCarrierException.run(
          `CE-${pad(carrierExceptionSeq, 3)}`,
          orderId,
          "delivery_failed",
          0,
          null,
          0,
          "carrier_webhook",
          hoursAgoIso(Math.max(ageHours - 36, 0), t0),
        );
      }
    }
  });

  seedAll();
}
