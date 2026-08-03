/**
 * The write path — PLAN.md Tier 1.
 *
 * Written BEFORE src/tools/write.ts is implemented. These tests are the actual
 * deliverable of Phase 4: the propose→execute gate is the product's safety
 * argument, and an untested gate is a claim rather than a control.
 *
 * Every test states a behaviour, not an implementation (CONVENTIONS.md B6).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createDb } from "../src/db/seed.js";
import { createQueries, type Db, type Queries } from "../src/db/queries.js";
import { proposeResolution, executeResolution } from "../src/tools/write.js";
import { isToolError, type ToolError } from "../src/errors.js";
import { buildActionKey, REFUND_CAP_CENTS } from "../src/policy.js";

let db: Db;
let q: Queries;

beforeEach(() => {
  // Fresh database per test: execution mutates state, and a shared instance would
  // make ordering matter.
  db = createDb(":memory:");
  q = createQueries(db);
});

afterEach(() => {
  db.close();
});

const REASON = "Investigated via get_order_timeline; acting on the verified carrier exception.";

interface Proposal {
  proposal_id: string;
  status: string;
  action: string;
  escalation_kind?: string;
  eligibility?: { eligible: boolean; first_failure: string | null; checks: unknown[] };
  plan: string;
}

interface Execution {
  executed: boolean;
  action: string;
  action_key?: string | null;
  escalation_id?: string;
  escalation_kind?: string;
  result_summary: string;
  audit_id: number;
  before_state: unknown;
  after_state: unknown;
}

/** Propose, asserting success. */
function propose(args: Parameters<typeof proposeResolution>[1]): Proposal {
  const r = proposeResolution(q, args);
  if (isToolError(r)) throw new Error(`unexpected propose error: ${r.error_code} — ${r.message}`);
  return r as unknown as Proposal;
}

function proposeErr(args: Parameters<typeof proposeResolution>[1]): ToolError {
  const r = proposeResolution(q, args);
  if (!isToolError(r)) throw new Error("expected a rejection, got a proposal");
  return r;
}

function execute(proposalId: string, confirmedBy = "saksham@example.com"): Execution {
  const r = executeResolution(q, { proposal_id: proposalId, confirmed_by: confirmedBy });
  if (isToolError(r)) throw new Error(`unexpected execute error: ${r.error_code} — ${r.message}`);
  return r as unknown as Execution;
}

function executeErr(proposalId: string): ToolError {
  const r = executeResolution(q, { proposal_id: proposalId });
  if (!isToolError(r)) throw new Error("expected a rejection, got an execution");
  return r;
}

const auditRows = (): Array<Record<string, unknown>> =>
  db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;

const paymentSnapshot = (): string =>
  JSON.stringify(db.prepare("SELECT * FROM payments ORDER BY id").all());

/** The eligible refund on the one order that supports it. */
const REFUND_1007 = {
  order_id: "ORD-1007",
  action: "refund" as const,
  target_id: "PAY-2008",
  amount_cents: 3_000,
  reasoning: REASON,
};

/* ==========================================================================
 * propose_resolution — validation
 * ========================================================================== */

describe("propose_resolution mutates nothing", () => {
  it("leaves payments untouched", () => {
    const before = paymentSnapshot();
    propose(REFUND_1007);
    expect(paymentSnapshot()).toBe(before);
  });

  it("writes no audit row — a proposal is not an attempted mutation", () => {
    propose(REFUND_1007);
    expect(auditRows()).toHaveLength(0);
  });
});

describe("propose_resolution rejects bad input through the error contract", () => {
  it("unknown order → not_found", () => {
    const e = proposeErr({ ...REFUND_1007, order_id: "ORD-9999" });
    expect(e.error_code).toBe("not_found");
  });

  it("target belonging to a different order → invalid_input", () => {
    const e = proposeErr({ ...REFUND_1007, target_id: "PAY-2001" });
    expect(e.error_code).toBe("invalid_input");
    expect(e.message.toLowerCase()).toContain("ord-1007");
  });

  it("refund without an amount → invalid_input naming amount_cents", () => {
    const { amount_cents: _omitted, ...withoutAmount } = REFUND_1007;
    const e = proposeErr(withoutAmount);
    expect(e.error_code).toBe("invalid_input");
    expect(e.hint).toContain("amount_cents");
  });

  it("refund against a non-captured payment → invalid_action_for_state", () => {
    const e = proposeErr({
      order_id: "ORD-1005",
      action: "refund",
      target_id: "PAY-2006", // status 'failed'
      amount_cents: 1_000,
      reasoning: REASON,
    });
    expect(e.error_code).toBe("invalid_action_for_state");
  });

  it("healthy order → no_action_needed, with the diagnostics that show it healthy", () => {
    const e = proposeErr({
      order_id: "ORD-2001",
      action: "refund",
      target_id: "PAY-3001",
      amount_cents: 100,
      reasoning: REASON,
    });
    expect(e.error_code).toBe("no_action_needed");
  });

  it("escalating a healthy order is also no_action_needed", () => {
    const e = proposeErr({
      order_id: "ORD-2001",
      action: "escalate",
      target_id: "ORD-2001",
      reasoning: REASON,
    });
    expect(e.error_code).toBe("no_action_needed");
  });
});

/* ==========================================================================
 * The redirect rule — ineligible is not an error
 * ========================================================================== */

describe("an ineligible refund redirects to an escalation rather than failing", () => {
  const overCap = {
    order_id: "ORD-1009",
    action: "refund" as const,
    target_id: "PAY-2010",
    amount_cents: 18_000,
    reasoning: REASON,
  };

  it("returns a pending proposal, not isError", () => {
    const p = propose(overCap);
    expect(p.status).toBe("pending");
  });

  it("flips the action to escalate with manager_approval", () => {
    const p = propose(overCap);
    expect(p.action).toBe("escalate");
    expect(p.escalation_kind).toBe("manager_approval");
  });

  it("carries the failed check as evidence and names it in the plan", () => {
    const p = propose(overCap);
    expect(p.eligibility?.eligible).toBe(false);
    expect(p.eligibility?.first_failure).toBe("amount_within_cap");
    expect(p.plan).toContain("$150.00");
  });

  it("executing the redirect creates one escalation and mutates no payment", () => {
    const before = paymentSnapshot();
    const p = propose(overCap);
    const r = execute(p.proposal_id);

    expect(r.action).toBe("escalate");
    expect(r.escalation_kind).toBe("manager_approval");
    expect(paymentSnapshot()).toBe(before);

    const escalations = db.prepare("SELECT * FROM escalations").all();
    expect(escalations).toHaveLength(1);

    const events = db
      .prepare("SELECT * FROM order_events WHERE order_id = 'ORD-1009' AND event_type = 'escalation_recorded'")
      .all();
    expect(events).toHaveLength(1);

    expect(auditRows().filter((a) => a["outcome"] === "success")).toHaveLength(1);
  });

  it("the policy enforces the cap independently of the schema", () => {
    // The schema caps amount_cents at 15000, but the schema is NOT the security
    // boundary — a caller reaching the handler directly must still be stopped. One
    // cent over the cap fails check 1, and the redirect rule turns that into an
    // escalation rather than an error, exactly as an over-cap request should.
    const p = propose({ ...overCap, amount_cents: REFUND_CAP_CENTS + 1 });
    expect(p.action).toBe("escalate");
    expect(p.eligibility?.eligible).toBe(false);
    expect(p.eligibility?.first_failure).toBe("amount_within_cap");
  });

  it("exactly the cap is not over it", () => {
    // Boundary, asserted on the write path and not only in policy.test.ts.
    const p = propose({ ...overCap, amount_cents: REFUND_CAP_CENTS });
    const capCheck = (p.eligibility?.checks as Array<{ id: string; passed: boolean }> | undefined)
      ?.find((c) => c.id === "amount_within_cap");
    expect(capCheck?.passed).toBe(true);
  });
});

/* ==========================================================================
 * The one executable refund
 * ========================================================================== */

describe("ORD-1007 — the only refund that executes", () => {
  it("proposes as a refund with all six checks passing", () => {
    const p = propose(REFUND_1007);
    expect(p.action).toBe("refund");
    expect(p.eligibility?.eligible).toBe(true);
    expect(p.eligibility?.checks).toHaveLength(6);
  });

  it("names the amount, the payment and the carrier exception in the plan", () => {
    const p = propose(REFUND_1007);
    expect(p.plan).toContain("$30.00");
    expect(p.plan).toContain("PAY-2008");
    expect(p.plan).toContain("CE-004");
  });

  it("execution increments refunded_cents rather than flipping status", () => {
    // A $30 refund against a $200 capture must not assert the whole $200 came back.
    execute(propose(REFUND_1007).proposal_id);
    const payment = q.getPaymentsForOrder("ORD-1007")[0];
    expect(payment?.status).toBe("captured");
    expect(payment?.refunded_cents).toBe(8_000); // 5000 prior + 3000 now
  });

  it("appends order events describing the refund", () => {
    execute(propose(REFUND_1007).proposal_id);
    const events = q.getEventsForOrder("ORD-1007");
    const refunds = events.filter((e) => e.event_type.startsWith("refund_"));
    expect(refunds.length).toBeGreaterThanOrEqual(2); // the prior one, plus ours
    expect(events.at(-1)?.detail).toContain("$30.00");
  });

  it("writes one audit row carrying the action_key and both snapshots", () => {
    const r = execute(propose(REFUND_1007).proposal_id);
    const rows = auditRows();
    expect(rows).toHaveLength(1);

    const row = rows[0] as Record<string, string | number | null>;
    expect(row["action"]).toBe("refund");
    expect(row["action_key"]).toBe(buildActionKey("ORD-1007", "CE-004"));
    expect(row["amount_cents"]).toBe(3_000);
    expect(row["outcome"]).toBe("success");
    expect(row["actor"]).toBe("saksham@example.com");
    expect(row["target_id"]).toBe("PAY-2008");

    // before/after must actually differ, and differ in the right direction.
    const before = JSON.parse(String(row["before_state"])) as { payments: Array<{ refunded_cents: number }> };
    const after = JSON.parse(String(row["after_state"])) as { payments: Array<{ refunded_cents: number }> };
    expect(before.payments[0]?.refunded_cents).toBe(5_000);
    expect(after.payments[0]?.refunded_cents).toBe(8_000);
    expect(r.audit_id).toBe(row["id"]);
  });

  it("records 'unattributed' when no confirmer is named", () => {
    const p = propose(REFUND_1007);
    const r = executeResolution(q, { proposal_id: p.proposal_id });
    expect(isToolError(r)).toBe(false);
    expect(auditRows()[0]?.["actor"]).toBe("unattributed");
  });

  it("the prior unrelated $50 refund does not block it", () => {
    // The whole reason action_key is defined per carrier exception.
    const p = propose(REFUND_1007);
    expect(p.action).toBe("refund");
    expect(p.eligibility?.eligible).toBe(true);
  });
});

/* ==========================================================================
 * Idempotency and concurrency
 * ========================================================================== */

describe("a proposal executes at most once", () => {
  it("unknown proposal_id → unknown_proposal", () => {
    const e = executeErr("PROP-00000000-0000-4000-8000-000000000000");
    expect(e.error_code).toBe("unknown_proposal");
    expect(e.hint).toContain("propose_resolution");
  });

  it("a second execution → already_executed, and the money moves only once", () => {
    const p = propose(REFUND_1007);
    execute(p.proposal_id);

    const e = executeErr(p.proposal_id);
    expect(e.error_code).toBe("already_executed");

    expect(q.getPaymentsForOrder("ORD-1007")[0]?.refunded_cents).toBe(8_000);
    expect(auditRows().filter((a) => a["outcome"] === "success")).toHaveLength(1);
  });

  it("two concurrent executions: exactly one wins", async () => {
    // better-sqlite3 is synchronous, so true parallelism is unreachable in-process.
    // What this proves is the conditional UPDATE guard: whichever call runs second
    // finds status != 'pending' and is refused. That guard is what would hold
    // across processes.
    const p = propose(REFUND_1007);
    const results = await Promise.all([
      Promise.resolve().then(() => executeResolution(q, { proposal_id: p.proposal_id })),
      Promise.resolve().then(() => executeResolution(q, { proposal_id: p.proposal_id })),
    ]);

    const successes = results.filter((r) => !isToolError(r));
    const failures = results.filter(isToolError);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error_code).toBe("already_executed");

    expect(auditRows().filter((a) => a["outcome"] === "success")).toHaveLength(1);
    expect(q.getPaymentsForOrder("ORD-1007")[0]?.refunded_cents).toBe(8_000);
  });

  it("a second proposal for the same action_key cannot also execute", () => {
    // Two independent proposals, same underlying remedy. The first executes; the
    // second must be refused on check 6, not silently double-refund.
    const first = propose(REFUND_1007);
    execute(first.proposal_id);

    const second = proposeResolution(q, REFUND_1007);
    if (isToolError(second)) {
      expect(["no_action_needed", "invalid_action_for_state"]).toContain(second.error_code);
      return;
    }
    const p = second as unknown as Proposal;
    expect(p.action).toBe("escalate");
    expect(p.eligibility?.first_failure).toBe("no_duplicate_refund");
  });
});

/* ==========================================================================
 * Staleness
 * ========================================================================== */

describe("execution refuses to act on state that changed", () => {
  it("→ stale_proposal, and the proposal is marked expired", () => {
    const p = propose(REFUND_1007);

    // Someone refunds the payment out from under the proposal.
    db.prepare("UPDATE payments SET refunded_cents = 10000 WHERE id = 'PAY-2008'").run();

    const e = executeErr(p.proposal_id);
    expect(e.error_code).toBe("stale_proposal");
    expect(e.hint).toContain("get_order_timeline");

    const row = db
      .prepare<[string], { status: string }>("SELECT status FROM proposals WHERE id = ?")
      .get(p.proposal_id);
    expect(row?.status).toBe("expired");
  });

  it("an order-status change is also caught", () => {
    const p = propose(REFUND_1007);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-1007'").run();
    expect(executeErr(p.proposal_id).error_code).toBe("stale_proposal");
  });

  it("policy is re-evaluated at execute time, never trusted from the proposal", () => {
    // Make the customer risky AFTER proposing. Snapshot covers order/payments/holds,
    // so this passes the staleness check and must be caught by re-evaluation.
    const p = propose(REFUND_1007);
    expect(p.action).toBe("refund");

    db.prepare("UPDATE customers SET risk_score = 95 WHERE id = 'CUST-0007'").run();

    const e = executeErr(p.proposal_id);
    expect(e.error_code).toBe("invalid_action_for_state");
    expect(e.message).toContain("risk");
    expect(q.getPaymentsForOrder("ORD-1007")[0]?.refunded_cents).toBe(5_000); // unchanged
  });
});

/* ==========================================================================
 * Rejections are audited; proposals are not
 * ========================================================================== */

describe("rejected executions write audit rows", () => {
  it("a stale execution leaves a rejected: row", () => {
    const p = propose(REFUND_1007);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-1007'").run();
    executeErr(p.proposal_id);

    const rejected = auditRows().filter((a) => String(a["outcome"]).startsWith("rejected:"));
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.["outcome"])).toContain("stale_proposal");
  });

  it("a double execution leaves a rejected: row alongside the success", () => {
    const p = propose(REFUND_1007);
    execute(p.proposal_id);
    executeErr(p.proposal_id);

    const rows = auditRows();
    expect(rows.filter((a) => a["outcome"] === "success")).toHaveLength(1);
    expect(rows.filter((a) => String(a["outcome"]).startsWith("rejected:"))).toHaveLength(1);
  });

  it("before_state equals after_state on a rejection — nothing moved", () => {
    const p = propose(REFUND_1007);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-1007'").run();
    executeErr(p.proposal_id);

    const row = auditRows().find((a) => String(a["outcome"]).startsWith("rejected:"));
    expect(row?.["before_state"]).toBe(row?.["after_state"]);
  });
});

/* ==========================================================================
 * Escalations
 * ========================================================================== */

describe("escalate records evidence and changes nothing else", () => {
  const escalate1006 = {
    order_id: "ORD-1006",
    action: "escalate" as const,
    target_id: "ORD-1006",
    reasoning: "Packed four days ago with no fulfillment events since; no automated remedy exists.",
  };

  it("ORD-1006 mutates nothing except the escalation row, an event, and an audit row", () => {
    const paymentsBefore = paymentSnapshot();
    const ordersBefore = JSON.stringify(db.prepare("SELECT * FROM orders ORDER BY id").all());
    const holdsBefore = JSON.stringify(db.prepare("SELECT * FROM inventory_holds ORDER BY id").all());

    execute(propose(escalate1006).proposal_id);

    expect(paymentSnapshot()).toBe(paymentsBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM orders ORDER BY id").all())).toBe(ordersBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM inventory_holds ORDER BY id").all())).toBe(holdsBefore);

    expect(db.prepare("SELECT * FROM escalations").all()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it("ORD-1002 escalates as human_review — a duplicate charge is never refunded", () => {
    const p = propose({
      order_id: "ORD-1002",
      action: "escalate",
      target_id: "ORD-1002",
      reasoning: "Two captures against a single order; processor state is diagnostic-only here.",
    });
    expect(p.escalation_kind).toBe("human_review");

    const r = execute(p.proposal_id);
    const row = db
      .prepare<[], { kind: string; reason: string; evidence: string }>("SELECT * FROM escalations")
      .get();
    expect(row?.kind).toBe("human_review");
    expect(row?.reason).toContain("duplicate");
    expect(r.escalation_id).toMatch(/^ESC-/);
  });

  it("the evidence packet is assembled, not free text", () => {
    execute(
      propose({
        order_id: "ORD-1002",
        action: "escalate",
        target_id: "ORD-1002",
        reasoning: "Two captures against a single order; needs a human decision.",
      }).proposal_id,
    );

    const row = db.prepare<[], { evidence: string }>("SELECT * FROM escalations").get();
    const evidence = JSON.parse(row?.evidence ?? "{}") as {
      diagnostics: { discrepancy_cents: number; flags: string[] };
      payments: Array<{ id: string; gateway_ref: string }>;
      timeline_excerpt: unknown[];
      holds: unknown[];
      carrier_exceptions: unknown[];
    };

    expect(evidence.diagnostics.discrepancy_cents).toBe(29_900);
    expect(evidence.diagnostics.flags).toContain("DOUBLE_CHARGE_SUSPECTED");
    expect(evidence.payments.map((p) => p.id).sort()).toEqual(["PAY-2002", "PAY-2003"]);
    expect(evidence.payments.map((p) => p.gateway_ref).sort()).toEqual(["ch_1002A", "ch_1002B"]);
    expect(evidence.timeline_excerpt.length).toBeGreaterThan(0);
    expect(evidence.timeline_excerpt.length).toBeLessThanOrEqual(10);
  });

  it("an ineligible refund's escalation carries the eligibility checks", () => {
    execute(
      propose({
        order_id: "ORD-1010",
        action: "refund",
        target_id: "PAY-2011",
        amount_cents: 4_000,
        reasoning: REASON,
      }).proposal_id,
    );

    const row = db.prepare<[], { kind: string; evidence: string }>("SELECT * FROM escalations").get();
    expect(row?.kind).toBe("manager_approval");
    const evidence = JSON.parse(row?.evidence ?? "{}") as {
      eligibility_checks: Array<{ id: string; passed: boolean }>;
    };
    expect(evidence.eligibility_checks).toHaveLength(6);
    expect(evidence.eligibility_checks.find((c) => !c.passed)?.id).toBe(
      "customer_risk_below_threshold",
    );
  });
});

/* ==========================================================================
 * The confirm-what-you-see guarantee
 * ========================================================================== */

describe("the escalation kind confirmed is the escalation kind recorded", () => {
  /*
   * Regression. propose hardcoded `manager_approval` on the ineligible-refund
   * redirect while execute re-derived from the payment rows, so a refund request on
   * ORD-1002 was confirmed as "manager approval" and filed as `human_review`.
   *
   * That is not cosmetic: the analyst confirms one thing and a different thing is
   * recorded, which defeats the entire point of the propose→execute split, and the
   * two kinds route to different human queues.
   */
  const kindOfEscalationRow = (): string =>
    (db.prepare<[], { kind: string }>("SELECT kind FROM escalations").get() as { kind: string }).kind;

  const ESCALATE_CASES = [
    ["ORD-1001", "ORD-1001"],
    ["ORD-1002", "ORD-1002"],
    ["ORD-1003", "ORD-1003"],
    ["ORD-1004", "HOLD-3004"],
    ["ORD-1005", "ORD-1005"],
    ["ORD-1006", "ORD-1006"],
    ["ORD-1009", "ORD-1009"],
    ["ORD-1010", "ORD-1010"],
    ["ORD-1011", "ORD-1011"],
  ] as const;

  it.each(ESCALATE_CASES)("%s: proposed kind == recorded kind (escalate)", (orderId, target) => {
    const p = propose({
      order_id: orderId,
      action: "escalate",
      target_id: target,
      reasoning: "Requires human judgment; recording evidence rather than acting automatically.",
    });
    execute(p.proposal_id);
    expect(kindOfEscalationRow()).toBe(p.escalation_kind);
  });

  const REDIRECT_CASES = [
    ["ORD-1002", "PAY-2003", 14_000],
    // 18000 = the real $180 gap. Above the schema max, so this reaches the handler
    // only on a direct call — which is the point: the schema is not the boundary.
    ["ORD-1009", "PAY-2010", 18_000],
    ["ORD-1010", "PAY-2011", 4_000],
    ["ORD-1011", "PAY-2012", 6_000],
  ] as const;

  it.each(REDIRECT_CASES)(
    "%s: proposed kind == recorded kind (ineligible refund redirect)",
    (orderId, target, amount) => {
      const p = propose({
        order_id: orderId,
        action: "refund",
        target_id: target,
        amount_cents: amount,
        reasoning: "Requesting a refund; expecting the policy to decide whether it is permitted.",
      });
      expect(p.action).toBe("escalate");
      execute(p.proposal_id);
      expect(kindOfEscalationRow()).toBe(p.escalation_kind);
    },
  );

  it("ORD-1002 is human_review at BOTH stages, even via a refund request", () => {
    // The exact reproduction. Duplicate charge wins over refund-ineligible.
    const p = propose({
      order_id: "ORD-1002",
      action: "refund",
      target_id: "PAY-2003",
      amount_cents: 14_000,
      reasoning: "Customer reports a duplicate charge; attempting a refund of the second capture.",
    });
    expect(p.escalation_kind).toBe("human_review");
    expect(p.plan).toContain("human-review");

    const r = execute(p.proposal_id);
    expect(r.escalation_kind).toBe("human_review");

    const row = db
      .prepare<[], { kind: string; reason: string }>("SELECT kind, reason FROM escalations")
      .get();
    expect(row?.kind).toBe("human_review");
    expect(row?.reason).toBe("duplicate_charge_suspected");
  });

  it("ORD-1009 is manager_approval at both stages", () => {
    const p = propose({
      order_id: "ORD-1009",
      action: "refund",
      target_id: "PAY-2010",
      amount_cents: 18_000,
      reasoning: "Verified damage claim exceeds the cap; expecting a manager-approval escalation.",
    });
    expect(p.escalation_kind).toBe("manager_approval");
    expect(p.plan).toContain("manager-approval");

    expect(execute(p.proposal_id).escalation_kind).toBe("manager_approval");
    expect(kindOfEscalationRow()).toBe("manager_approval");
  });

  it("execute reads the stored classification rather than re-deriving it", () => {
    // Persisted on the proposal, so the filed escalation is provably the confirmed
    // one — and classification comes under the staleness guard for free.
    const p = propose({
      order_id: "ORD-1002",
      action: "escalate",
      target_id: "ORD-1002",
      reasoning: "Duplicate capture requires a human decision; no automated remedy is permitted.",
    });
    const stored = db
      .prepare<[string], { escalation_kind: string; escalation_reason: string }>(
        "SELECT escalation_kind, escalation_reason FROM proposals WHERE id = ?",
      )
      .get(p.proposal_id);
    expect(stored?.escalation_kind).toBe(p.escalation_kind);
    expect(stored?.escalation_reason).toBe("duplicate_charge_suspected");
  });
});

describe("action_key is deliberately null on escalate audit rows", () => {
  it("an escalation writes no action key — no refund key exists to write", () => {
    // Confirming this is intentional rather than a fallthrough: the partial unique
    // index covers successful refunds, and reserving a key for an escalation would
    // be a lie that could block a later legitimate refund.
    execute(
      propose({
        order_id: "ORD-1006",
        action: "escalate",
        target_id: "ORD-1006",
        reasoning: "Packed four days ago with no fulfillment events; no automated remedy exists.",
      }).proposal_id,
    );
    const row = auditRows()[0];
    expect(row?.["action"]).toBe("escalate");
    expect(row?.["action_key"]).toBeNull();
  });

  it("and an eligible refund does write one", () => {
    execute(propose(REFUND_1007).proposal_id);
    expect(auditRows()[0]?.["action_key"]).toBe(buildActionKey("ORD-1007", "CE-004"));
  });
});

/* ==========================================================================
 * Structural: processor state moves only on the eligible-refund branch
 * ========================================================================== */

describe("no path mutates payment state outside the eligible-refund branch", () => {
  it("payment rows are byte-identical across every escalate execution", () => {
    const before = paymentSnapshot();

    for (const [orderId, target] of [
      ["ORD-1001", "ORD-1001"],
      ["ORD-1002", "ORD-1002"],
      ["ORD-1003", "ORD-1003"],
      ["ORD-1004", "HOLD-3004"],
      ["ORD-1005", "ORD-1005"],
      ["ORD-1006", "ORD-1006"],
    ] as const) {
      const p = propose({
        order_id: orderId,
        action: "escalate",
        target_id: target,
        reasoning: "Requires human judgment; no automated remedy is permitted here.",
      });
      execute(p.proposal_id);
    }

    expect(paymentSnapshot()).toBe(before);
    expect(db.prepare("SELECT * FROM escalations").all()).toHaveLength(6);
  });

  it("the stuck refund on ORD-1003 is never retried", () => {
    // Processor state is diagnostic-only. Escalating must not touch it.
    const before = q.getPaymentsForOrder("ORD-1003")[0];
    execute(
      propose({
        order_id: "ORD-1003",
        action: "escalate",
        target_id: "ORD-1003",
        reasoning: "Refund initiated five days ago and never settled; processor action is prohibited.",
      }).proposal_id,
    );
    const after = q.getPaymentsForOrder("ORD-1003")[0];
    expect(after).toEqual(before);
    expect(after?.status).toBe("refund_initiated");
  });
});
