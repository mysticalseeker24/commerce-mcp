/**
 * Refund eligibility engine — SPEC.md §4.4.
 *
 * Written BEFORE src/policy.ts is implemented (PLAN.md Phase 4 discipline, pulled
 * forward because get_order_timeline needs the engine in Phase 2).
 *
 * The load-bearing property: each of the six checks must be shown failing **in
 * isolation**. A fixture that fails two checks proves nothing about either, which
 * is why ORD-1009/1010/1011 exist as separate scenarios.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb } from "../src/db/seed.js";
import {
  createQueries,
  type Db,
  type Queries,
  type OrderRow,
  type PaymentRow,
  type CustomerRow,
  type CarrierExceptionRow,
} from "../src/db/queries.js";
import {
  buildActionKey,
  evaluateRefundEligibility,
  MAX_ORDER_AGE_DAYS,
  REFUND_CAP_CENTS,
  RISK_SCORE_THRESHOLD,
  type EligibilityInput,
} from "../src/policy.js";

let db: Db;
let q: Queries;

beforeAll(() => {
  db = createDb(":memory:");
  q = createQueries(db);
});

afterAll(() => {
  db.close();
});

/** Assemble a real evaluation input straight from seeded rows. */
function inputFor(orderId: string, amountCents: number, priorKeys: string[] = []): EligibilityInput {
  const order = q.getOrder(orderId) as OrderRow;
  const payment = q.getPaymentsForOrder(orderId)[0] as PaymentRow;
  const customer = q.getCustomer(order.customer_id) as CustomerRow;
  return {
    order,
    payment,
    customer,
    carrierExceptions: q.getCarrierExceptionsForOrder(orderId),
    priorRefundActionKeys: priorKeys,
    amountCents,
  };
}

describe("action_key", () => {
  it("identifies a refund by order and the carrier exception justifying it", () => {
    expect(buildActionKey("ORD-1007", "CE-004")).toBe("refund:ORD-1007:CE-004");
  });

  it("distinguishes two refunds on the same order with different exceptions", () => {
    expect(buildActionKey("ORD-1007", "CE-004")).not.toBe(buildActionKey("ORD-1007", "CE-099"));
  });
});

describe("ORD-1007 — the only executable case", () => {
  it("passes all six checks for a $30.00 refund", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1007", 3_000));
    expect(result.first_failure).toBeNull();
    expect(result.eligible).toBe(true);
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("gives every check a human-readable evidence string", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1007", 3_000));
    for (const check of result.checks) {
      expect(check.evidence.length).toBeGreaterThan(0);
      expect(check.label.length).toBeGreaterThan(0);
    }
    const risk = result.checks.find((c) => c.id === "customer_risk_below_threshold");
    expect(risk?.evidence).toContain("30");
    const carrier = result.checks.find((c) => c.id === "verified_carrier_exception");
    expect(carrier?.evidence).toContain("CE-004");
    expect(carrier?.evidence).toContain("return_received");
  });

  it("the prior unrelated $50.00 refund does not trip no_duplicate_refund", () => {
    // A goodwill adjustment carries a different action_key than a carrier-exception
    // refund. This is the entire reason action_key is defined the way it is.
    const unrelatedKey = buildActionKey("ORD-1007", "CE-GOODWILL");
    const result = evaluateRefundEligibility(inputFor("ORD-1007", 3_000, [unrelatedKey]));
    expect(result.eligible).toBe(true);
    expect(result.checks.find((c) => c.id === "no_duplicate_refund")?.passed).toBe(true);
  });
});

describe("each check fails in isolation", () => {
  it("check 1 — amount_within_cap: ORD-1009's $180.00 gap exceeds the $150.00 cap", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1009", 18_000));
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("amount_within_cap");
    // Every OTHER check passes — that is what makes it a near miss.
    const others = result.checks.filter((c) => c.id !== "amount_within_cap");
    expect(others.every((c) => c.passed)).toBe(true);
  });

  it("check 2 — amount_within_paid: request exceeds refundable on the target payment", () => {
    // ORD-1007 has $150.00 refundable ($200.00 captured less $50.00 already refunded).
    // Ask for $160.00: under the cap? No — so use a payment with more headroom.
    // ORD-1009's payment has $420.00 refundable, so a $140.00 request clears the cap
    // and check 2 must be provoked separately.
    const input = inputFor("ORD-1007", 14_000);
    const result = evaluateRefundEligibility({
      ...input,
      payment: { ...input.payment, amount_cents: 20_000, refunded_cents: 19_000 },
    });
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("amount_within_paid");
    expect(result.checks.find((c) => c.id === "amount_within_cap")?.passed).toBe(true);
  });

  it("check 3 — order_within_age: ORD-1011 is 45 days old", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1011", 6_000));
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("order_within_age");
    const others = result.checks.filter((c) => c.id !== "order_within_age");
    expect(others.every((c) => c.passed)).toBe(true);
  });

  it("check 4 — customer_risk_below_threshold: ORD-1010's customer is risk 85", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1010", 4_000));
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("customer_risk_below_threshold");
    const others = result.checks.filter((c) => c.id !== "customer_risk_below_threshold");
    expect(others.every((c) => c.passed)).toBe(true);
  });

  it("check 5 — verified_carrier_exception: an unverified exception does not count", () => {
    const input = inputFor("ORD-1007", 3_000);
    const unverified: CarrierExceptionRow = {
      ...(input.carrierExceptions[0] as CarrierExceptionRow),
      verified: 0,
      verified_at: null,
    };
    const result = evaluateRefundEligibility({ ...input, carrierExceptions: [unverified] });
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("verified_carrier_exception");
  });

  it("check 5 — no carrier exception at all also fails", () => {
    const result = evaluateRefundEligibility({ ...inputFor("ORD-1007", 3_000), carrierExceptions: [] });
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("verified_carrier_exception");
  });

  it("check 6 — no_duplicate_refund: the same action_key was already refunded", () => {
    const sameKey = buildActionKey("ORD-1007", "CE-004");
    const result = evaluateRefundEligibility(inputFor("ORD-1007", 3_000, [sameKey]));
    expect(result.eligible).toBe(false);
    expect(result.first_failure).toBe("no_duplicate_refund");
    const others = result.checks.filter((c) => c.id !== "no_duplicate_refund");
    expect(others.every((c) => c.passed)).toBe(true);
  });
});

describe("boundaries are exact", () => {
  it(`amount: exactly ${REFUND_CAP_CENTS} passes, one cent more fails`, () => {
    // Use a payment with enough headroom that only the cap can fail.
    const base = inputFor("ORD-1009", REFUND_CAP_CENTS);
    expect(evaluateRefundEligibility(base).checks.find((c) => c.id === "amount_within_cap")?.passed).toBe(true);

    const over = evaluateRefundEligibility({ ...base, amountCents: REFUND_CAP_CENTS + 1 });
    expect(over.checks.find((c) => c.id === "amount_within_cap")?.passed).toBe(false);
    expect(over.first_failure).toBe("amount_within_cap");
  });

  it(`age: exactly ${MAX_ORDER_AGE_DAYS} days passes, ${MAX_ORDER_AGE_DAYS + 1} fails`, () => {
    const base = inputFor("ORD-1007", 3_000);
    const now = new Date();
    const daysAgo = (n: number): string =>
      new Date(now.getTime() - n * 86_400_000).toISOString();

    const exact = evaluateRefundEligibility({
      ...base,
      order: { ...base.order, created_at: daysAgo(MAX_ORDER_AGE_DAYS) },
      now,
    });
    expect(exact.checks.find((c) => c.id === "order_within_age")?.passed).toBe(true);

    const over = evaluateRefundEligibility({
      ...base,
      order: { ...base.order, created_at: daysAgo(MAX_ORDER_AGE_DAYS + 1) },
      now,
    });
    expect(over.checks.find((c) => c.id === "order_within_age")?.passed).toBe(false);
  });

  it(`risk: ${RISK_SCORE_THRESHOLD - 1} passes, ${RISK_SCORE_THRESHOLD} fails`, () => {
    const base = inputFor("ORD-1007", 3_000);

    const under = evaluateRefundEligibility({
      ...base,
      customer: { ...base.customer, risk_score: RISK_SCORE_THRESHOLD - 1 },
    });
    expect(under.checks.find((c) => c.id === "customer_risk_below_threshold")?.passed).toBe(true);

    const at = evaluateRefundEligibility({
      ...base,
      customer: { ...base.customer, risk_score: RISK_SCORE_THRESHOLD },
    });
    expect(at.checks.find((c) => c.id === "customer_risk_below_threshold")?.passed).toBe(false);
  });

  it("amount_within_paid: exactly refundable passes, one cent more fails", () => {
    const base = inputFor("ORD-1007", 3_000);
    const payment: PaymentRow = { ...base.payment, amount_cents: 20_000, refunded_cents: 15_000 };
    // refundable = 5000

    const exact = evaluateRefundEligibility({ ...base, payment, amountCents: 5_000 });
    expect(exact.checks.find((c) => c.id === "amount_within_paid")?.passed).toBe(true);

    const over = evaluateRefundEligibility({ ...base, payment, amountCents: 5_001 });
    expect(over.checks.find((c) => c.id === "amount_within_paid")?.passed).toBe(false);
  });
});

describe("first_failure reports the EARLIEST failing check", () => {
  it("an order failing several checks names the first in SPEC order", () => {
    // ORD-1010: risky customer (check 4). Ask for an over-cap amount too (check 1).
    const result = evaluateRefundEligibility(inputFor("ORD-1010", REFUND_CAP_CENTS + 1));
    expect(result.first_failure).toBe("amount_within_cap");
    expect(result.checks.find((c) => c.id === "customer_risk_below_threshold")?.passed).toBe(false);
  });

  it("always evaluates all six checks, even after one fails", () => {
    // The analyst needs the full picture, not just the first problem.
    const result = evaluateRefundEligibility(inputFor("ORD-1010", REFUND_CAP_CENTS + 1));
    expect(result.checks).toHaveLength(6);
  });
});

describe("ORD-1002 — the duplicate charge is never refundable", () => {
  it("fails on the missing carrier exception and the risky customer", () => {
    const result = evaluateRefundEligibility(inputFor("ORD-1002", 29_900));
    expect(result.eligible).toBe(false);
    expect(result.checks.find((c) => c.id === "customer_risk_below_threshold")?.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "verified_carrier_exception")?.passed).toBe(false);
  });
});
