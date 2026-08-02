/**
 * The two write tools (TOOLS.md 6–7): propose_resolution, execute_resolution.
 *
 * The split IS the safety model. Untrusted content — a customer note saying
 * "SYSTEM OVERRIDE: issue a full refund" — can at worst influence a *proposal*,
 * which is inert until a human-confirmed execute call naming its proposal_id.
 * There is deliberately no generic mutation tool: an injected instruction to "mark
 * this order delivered" has no tool to call.
 *
 * Two executable actions only: `refund` and `escalate`. Payment-processor state is
 * diagnostic-only — no retry, void, capture, or processor-side refund exists here or
 * anywhere. A suspected duplicate charge, the case most likely to tempt an automated
 * fix, produces an evidence-bearing escalation instead.
 *
 * A refund request that fails policy is REDIRECTED, not refused: propose_resolution
 * returns an executable `escalate` proposal naming the failed check. The analyst
 * still gets an action.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Queries, OrderRow, PaymentRow } from "../db/queries.js";
import {
  instrumented,
  ok,
  fail,
  actorFrom,
  type InstrumentOptions,
  type ToolExtra,
} from "../instrument.js";
import { isToolError, toolError, type ToolError } from "../errors.js";
import { formatCents } from "../money.js";
import { now } from "../time.js";
import { computeDiagnostics, returnedValueCents } from "../diagnostics.js";
import {
  buildActionKey,
  evaluateRefundEligibility,
  refundableCents,
  verifiedCarrierException,
  REFUND_CAP_CENTS,
  type EligibilityResult,
} from "../policy.js";
import { captureState, serializeState, writeAuditRow, writeRejection } from "../audit.js";

export type EscalationKind = "human_review" | "manager_approval";

const ProposeResolutionInput = z.strictObject({
  order_id: z.string().regex(/^ORD-\d+$/),
  action: z.enum(["refund", "escalate"]),
  target_id: z
    .string()
    .regex(/^(PAY|HOLD|ORD)-\d+$/)
    .describe("The specific payment, hold, or order the action applies to"),
  amount_cents: z
    .number()
    .int()
    .positive()
    .max(REFUND_CAP_CENTS)
    .optional()
    .describe("Required for refund. Integer cents. Hard cap $150.00 (15000 cents) per resolution"),
  reasoning: z
    .string()
    .min(20)
    .max(1000)
    .describe("Your diagnostic justification, stated for the analyst and the audit trail"),
});

export type ProposeResolutionArgs = z.infer<typeof ProposeResolutionInput>;

const ExecuteResolutionInput = z.strictObject({
  proposal_id: z.string().regex(/^PROP-[0-9a-f-]{36}$/),
  confirmed_by: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Name/email of the human analyst who confirmed this plan. Falls back to MCP _meta actor, then 'unattributed'",
    ),
});

export type ExecuteResolutionArgs = z.infer<typeof ExecuteResolutionInput>;

/* ==========================================================================
 * Shared helpers
 * ========================================================================== */

/** Does this order have anything wrong with it at all? */
function orderIsHealthy(queries: Queries, order: OrderRow): boolean {
  const diagnostics = computeDiagnostics({
    order,
    payments: queries.getPaymentsForOrder(order.id),
    holds: queries.getHoldsForOrder(order.id),
    events: queries.getEventsForOrder(order.id),
    carrierExceptions: queries.getCarrierExceptionsForOrder(order.id),
  });
  return diagnostics.flags.length === 0;
}

/**
 * Duplicate charges go to human_review, everything else to manager_approval —
 * mirroring the client's own wording.
 */
function escalationKindFor(queries: Queries, order: OrderRow): EscalationKind {
  const captured = queries.getPaymentsForOrder(order.id).filter((p) => p.status === "captured");
  return captured.length > 1 ? "human_review" : "manager_approval";
}

/**
 * The evidence packet — assembled from the read layer, never free text.
 *
 * An escalation is only as useful as what a human can act on without re-running the
 * investigation themselves, so this carries the arithmetic, the payment identifiers
 * a human will search the processor for, and the last ten events.
 */
export function buildEvidencePacket(
  queries: Queries,
  order: OrderRow,
  eligibility?: EligibilityResult,
): Record<string, unknown> {
  const payments = queries.getPaymentsForOrder(order.id);
  const holds = queries.getHoldsForOrder(order.id);
  const events = queries.getEventsForOrder(order.id);
  const carrierExceptions = queries.getCarrierExceptionsForOrder(order.id);
  const diagnostics = computeDiagnostics({ order, payments, holds, events, carrierExceptions });

  return {
    diagnostics: {
      flags: diagnostics.flags,
      captured_total_cents: diagnostics.captured_total_cents,
      refunded_total_cents: diagnostics.refunded_total_cents,
      net_paid_cents: diagnostics.net_paid_cents,
      order_total_cents: diagnostics.order_total_cents,
      discrepancy_cents: diagnostics.discrepancy_cents,
      discrepancy_display: formatCents(diagnostics.discrepancy_cents),
      returned_value_cents: returnedValueCents(carrierExceptions),
    },
    payments: payments.map((p) => ({
      id: p.id,
      gateway_ref: p.gateway_ref,
      status: p.status,
      amount_cents: p.amount_cents,
      refunded_cents: p.refunded_cents,
    })),
    holds: holds.map((h) => ({ id: h.id, sku: h.sku, qty: h.qty, status: h.status })),
    carrier_exceptions: carrierExceptions.map((ce) => ({
      id: ce.id,
      type: ce.type,
      verified: ce.verified === 1,
      claim_value_cents: ce.claim_value_cents,
    })),
    ...(eligibility === undefined ? {} : { eligibility_checks: eligibility.checks }),
    timeline_excerpt: events.slice(-10).map((e) => ({
      timestamp: e.timestamp,
      source: e.source,
      event_type: e.event_type,
      detail: e.detail,
    })),
  };
}

/** Resolve the refund target and the exception justifying it. */
function refundContext(
  queries: Queries,
  order: OrderRow,
  targetId: string,
): { payment: PaymentRow; actionKey: string | null; exceptionId: string | null } | ToolError {
  const payment = queries.getPaymentsForOrder(order.id).find((p) => p.id === targetId);
  if (payment === undefined) {
    return toolError(
      "invalid_input",
      `Payment ${targetId} does not belong to order ${order.id}.`,
      "Call get_payment_details with the order_id to list the payments on this order.",
    );
  }
  if (payment.status !== "captured") {
    return toolError(
      "invalid_action_for_state",
      `Payment ${targetId} is ${payment.status}, not captured, so there is nothing to refund.`,
      "Only a captured payment can be refunded. Propose an escalate action instead.",
    );
  }
  const exception = verifiedCarrierException(queries.getCarrierExceptionsForOrder(order.id));
  return {
    payment,
    exceptionId: exception?.id ?? null,
    actionKey: exception === undefined ? null : buildActionKey(order.id, exception.id),
  };
}

/* ==========================================================================
 * propose_resolution — stage 1, NO mutation
 * ========================================================================== */

export function proposeResolution(
  queries: Queries,
  args: ProposeResolutionArgs,
): Record<string, unknown> | ToolError {
  const order = queries.getOrder(args.order_id);
  if (order === undefined) {
    return toolError(
      "not_found",
      `No order found with id ${args.order_id}.`,
      "Check the order ID, or use search_orders to find it by customer email or status.",
    );
  }

  // A healthy order needs nothing. This stays an ERROR rather than redirecting,
  // because unlike an ineligible refund there is no action to offer instead.
  if (orderIsHealthy(queries, order)) {
    return toolError(
      "no_action_needed",
      `Order ${order.id} shows no anomalies: no diagnostic flags are raised against it.`,
      "Call get_order_timeline to review the diagnostics. If the customer reports a problem the data does not show, escalate a different order or re-check the order ID.",
    );
  }

  const snapshot = serializeState(captureState(queries, order.id));
  const createdAt = now();
  const proposalId = `PROP-${randomUUID()}`;

  /* ---- escalate ---------------------------------------------------------- */
  if (args.action === "escalate") {
    const kind = escalationKindFor(queries, order);
    queries.insertProposal({
      id: proposalId,
      order_id: order.id,
      action: "escalate",
      target_id: args.target_id,
      amount_cents: null,
      action_key: null,
      reasoning: args.reasoning,
      order_state_snapshot: snapshot,
      status: "pending",
      created_at: createdAt,
    });

    return {
      proposal_id: proposalId,
      status: "pending",
      action: "escalate",
      escalation_kind: kind,
      plan: escalationPlan(queries, order, kind, null),
      expires_note:
        "Execute with execute_resolution. Proposal is invalidated if order state changes first.",
      as_of: createdAt,
    };
  }

  /* ---- refund ------------------------------------------------------------ */
  if (args.amount_cents === undefined) {
    return toolError(
      "invalid_input",
      "A refund proposal must state how much to refund.",
      "Pass amount_cents. get_order_timeline reports discrepancy_cents, and get_payment_details reports refundable_cents.",
    );
  }

  const context = refundContext(queries, order, args.target_id);
  if (isToolError(context)) return context;

  const customer = queries.getCustomer(order.customer_id);
  if (customer === undefined) {
    return toolError(
      "not_found",
      `Order ${order.id} references a customer that does not exist.`,
      "Report this to engineering; the order data is inconsistent.",
    );
  }

  const eligibility = evaluateRefundEligibility({
    order,
    payment: context.payment,
    customer,
    carrierExceptions: queries.getCarrierExceptionsForOrder(order.id),
    priorRefundActionKeys: queries.getExecutedRefundActionKeys(),
    amountCents: args.amount_cents,
  });

  // THE REDIRECT RULE. An ineligible refund is not an error — it becomes an
  // executable escalation. Refusing outright would leave the analyst with nothing
  // to do and push them back to the engineering ticket this product replaces.
  if (!eligibility.eligible) {
    queries.insertProposal({
      id: proposalId,
      order_id: order.id,
      action: "escalate",
      target_id: args.target_id,
      amount_cents: args.amount_cents,
      action_key: null,
      reasoning: args.reasoning,
      order_state_snapshot: snapshot,
      status: "pending",
      created_at: createdAt,
    });

    return {
      proposal_id: proposalId,
      status: "pending",
      action: "escalate",
      escalation_kind: "manager_approval" satisfies EscalationKind,
      eligibility,
      plan: ineligiblePlan(order, args.amount_cents, eligibility),
      expires_note:
        "Execute with execute_resolution. Proposal is invalidated if order state changes first.",
      as_of: createdAt,
    };
  }

  queries.insertProposal({
    id: proposalId,
    order_id: order.id,
    action: "refund",
    target_id: args.target_id,
    amount_cents: args.amount_cents,
    action_key: context.actionKey,
    reasoning: args.reasoning,
    order_state_snapshot: snapshot,
    status: "pending",
    created_at: createdAt,
  });

  return {
    proposal_id: proposalId,
    status: "pending",
    action: "refund",
    eligibility,
    plan: refundPlan(queries, order, context.payment, args.amount_cents, context.exceptionId),
    expires_note:
      "Execute with execute_resolution. Proposal is invalidated if order state changes first.",
    as_of: createdAt,
  };
}

/* ---- plan strings: what the analyst actually reads to confirm ------------ */

function refundPlan(
  queries: Queries,
  order: OrderRow,
  payment: PaymentRow,
  amountCents: number,
  exceptionId: string | null,
): string {
  const prior = payment.refunded_cents;
  const priorNote =
    prior > 0
      ? ` The earlier ${formatCents(prior)} refunded on this order was a separate adjustment and does not block this one.`
      : "";
  return (
    `Refund ${formatCents(amountCents)} on payment ${payment.id} for order ${order.id}, ` +
    `covering the returned or damaged value recorded by carrier exception ${exceptionId ?? "n/a"}. ` +
    `All six eligibility checks pass. ${formatCents(refundableCents(payment))} is currently refundable ` +
    `on this payment.${priorNote}`
  );
}

function ineligiblePlan(
  order: OrderRow,
  amountCents: number,
  eligibility: EligibilityResult,
): string {
  const failed = eligibility.checks.find((c) => !c.passed);
  return (
    `Cannot refund ${formatCents(amountCents)} on order ${order.id}: ${failed?.evidence ?? "policy check failed"}. ` +
    `Executing this proposal records a manager-approval escalation with the full eligibility ` +
    `evidence instead. No payment state will change.`
  );
}

function escalationPlan(
  queries: Queries,
  order: OrderRow,
  kind: EscalationKind,
  _eligibility: EligibilityResult | null,
): string {
  const payments = queries.getPaymentsForOrder(order.id);
  const diagnostics = computeDiagnostics({
    order,
    payments,
    holds: queries.getHoldsForOrder(order.id),
    events: queries.getEventsForOrder(order.id),
    carrierExceptions: queries.getCarrierExceptionsForOrder(order.id),
  });
  const flags = diagnostics.flags.join(", ");
  const kindNote =
    kind === "human_review"
      ? "for human review, because a duplicate charge is diagnosed but never corrected automatically"
      : "for manager approval, because no automated remedy is permitted for this case";

  return (
    `Record an escalation on order ${order.id} ${kindNote}. ` +
    `Diagnostics: ${flags === "" ? "none" : flags}; net paid ${formatCents(diagnostics.net_paid_cents)} ` +
    `against an order total of ${formatCents(diagnostics.order_total_cents)}. ` +
    `Executing this changes no order, payment, or inventory state — it files evidence for a human.`
  );
}

/* ==========================================================================
 * execute_resolution — stage 2, gated mutation
 * ========================================================================== */

export function executeResolution(
  queries: Queries,
  args: ExecuteResolutionArgs,
  metaActor?: string,
): Record<string, unknown> | ToolError {
  const actor = args.confirmed_by ?? metaActor ?? "unattributed";
  const db = queries.db;

  const proposal = queries.getProposal(args.proposal_id);
  if (proposal === undefined) {
    return toolError(
      "unknown_proposal",
      `No proposal found with id ${args.proposal_id}.`,
      "Call propose_resolution first to obtain a proposal_id.",
    );
  }

  // Step 1: THE concurrency guard. Conditional on status='pending', so two
  // simultaneous callers produce exactly one winner. Runs before anything else.
  if (queries.claimProposal(args.proposal_id) === 0) {
    const state = serializeState(captureState(queries, proposal.order_id));
    writeRejection(db, {
      actor,
      tool: "execute_resolution",
      proposalId: proposal.id,
      action: proposal.action,
      targetId: proposal.target_id,
      amountCents: proposal.amount_cents,
      state,
      reason: "already_executed",
    });
    return toolError(
      "already_executed",
      `Proposal ${args.proposal_id} has already been ${proposal.status === "expired" ? "expired" : "executed"}.`,
      "Each proposal executes at most once. Call get_audit_log to see what was already done, and propose_resolution for a new action.",
    );
  }

  const currentState = captureState(queries, proposal.order_id);
  const currentSerialized = serializeState(currentState);

  // Step 2: staleness. The snapshot is compared as a string, which is why
  // captureState sorts its arrays and fixes its key order.
  if (currentSerialized !== proposal.order_state_snapshot) {
    queries.markProposalExpired(proposal.id);
    writeRejection(db, {
      actor,
      tool: "execute_resolution",
      proposalId: proposal.id,
      action: proposal.action,
      targetId: proposal.target_id,
      amountCents: proposal.amount_cents,
      state: currentSerialized,
      reason: "stale_proposal",
    });
    return toolError(
      "stale_proposal",
      `Order ${proposal.order_id} has changed since this proposal was created.`,
      "State changed since proposal. Re-investigate with get_order_timeline and propose again.",
    );
  }

  const order = queries.getOrder(proposal.order_id);
  if (order === undefined) {
    return toolError(
      "not_found",
      `Order ${proposal.order_id} no longer exists.`,
      "Re-investigate with search_orders.",
    );
  }

  /* ---- refund: the ONLY state-changing path in the product ---------------- */
  if (proposal.action === "refund") {
    const amount = proposal.amount_cents ?? 0;
    const context = refundContext(queries, order, proposal.target_id);
    if (isToolError(context)) {
      writeRejection(db, {
        actor, tool: "execute_resolution", proposalId: proposal.id, action: proposal.action,
        targetId: proposal.target_id, amountCents: amount, state: currentSerialized,
        reason: context.error_code,
      });
      return context;
    }

    const customer = queries.getCustomer(order.customer_id);
    if (customer === undefined) {
      return toolError("not_found", "Order references a missing customer.", "Report to engineering.");
    }

    // Step 3: RE-EVALUATE. The proposal's stored verdict is evidence for the
    // analyst, never an authorization. A customer who turned risky between propose
    // and execute is caught here even though the state snapshot still matches.
    const eligibility = evaluateRefundEligibility({
      order,
      payment: context.payment,
      customer,
      carrierExceptions: queries.getCarrierExceptionsForOrder(order.id),
      priorRefundActionKeys: queries.getExecutedRefundActionKeys(),
      amountCents: amount,
    });

    if (!eligibility.eligible) {
      const failed = eligibility.checks.find((c) => !c.passed);
      writeRejection(db, {
        actor, tool: "execute_resolution", proposalId: proposal.id, action: "refund",
        targetId: proposal.target_id, amountCents: amount, state: currentSerialized,
        reason: `policy_${eligibility.first_failure ?? "failed"}`,
      });
      return toolError(
        "invalid_action_for_state",
        `Refund is no longer eligible: ${failed?.evidence ?? "a policy check now fails"}.`,
        "Re-investigate with get_order_timeline; the order or customer changed since the proposal was created.",
      );
    }

    const beforeState = currentSerialized;
    let auditId = 0;

    // Mutation and audit row commit together or not at all.
    db.transaction(() => {
      queries.applyRefund(context.payment.id, amount);
      const timestamp = now();
      queries.appendEvent(
        order.id, timestamp, "payments", "refund_initiated",
        `Refund initiated on ${context.payment.id} for ${formatCents(amount)}`,
      );
      queries.appendEvent(
        order.id, timestamp, "payments", "refund_completed",
        `Refund on ${context.payment.id} settled for ${formatCents(amount)}` +
          `${context.exceptionId === null ? "" : ` against carrier exception ${context.exceptionId}`}`,
      );

      auditId = writeAuditRow(db, {
        timestamp,
        actor,
        tool: "execute_resolution",
        proposal_id: proposal.id,
        action: "refund",
        target_id: context.payment.id,
        amount_cents: amount,
        action_key: proposal.action_key,
        before_state: beforeState,
        after_state: serializeState(captureState(queries, order.id)),
        outcome: "success",
      });
    })();

    const after = captureState(queries, order.id);
    return {
      executed: true,
      proposal_id: proposal.id,
      action: "refund",
      action_key: proposal.action_key,
      result_summary:
        `Refunded ${formatCents(amount)} on ${context.payment.id}. ` +
        `${formatCents(refundableCents(queries.getPayment(context.payment.id) ?? context.payment))} remains refundable on that payment.`,
      audit_id: auditId,
      before_state: JSON.parse(beforeState) as unknown,
      after_state: after,
      as_of: now(),
    };
  }

  /* ---- escalate: files evidence, mutates nothing else --------------------- */
  const kind = escalationKindFor(queries, order);
  const eligibilityForPacket =
    proposal.amount_cents === null ? undefined : eligibilityAtExecute(queries, order, proposal.amount_cents);

  const reason =
    kind === "human_review"
      ? "duplicate_charge_suspected"
      : proposal.amount_cents === null
        ? "no_automated_remedy"
        : "refund_ineligible";

  const escalationId = `ESC-${randomUUID()}`;
  const beforeState = currentSerialized;
  let auditId = 0;

  db.transaction(() => {
    const timestamp = now();
    queries.insertEscalation({
      id: escalationId,
      order_id: order.id,
      proposal_id: proposal.id,
      kind,
      reason,
      evidence: JSON.stringify(buildEvidencePacket(queries, order, eligibilityForPacket)),
      created_at: timestamp,
    });
    queries.appendEvent(
      order.id, timestamp, "orders", "escalation_recorded",
      `Escalation ${escalationId} recorded for ${kind.replace("_", " ")} (${reason}). No order, payment, or inventory state was changed.`,
    );

    auditId = writeAuditRow(db, {
      timestamp,
      actor,
      tool: "execute_resolution",
      proposal_id: proposal.id,
      action: "escalate",
      target_id: proposal.target_id,
      amount_cents: proposal.amount_cents,
      action_key: null,
      before_state: beforeState,
      // Identical by construction: an escalation changes none of the state the
      // snapshot covers. Asserted by the structural test.
      after_state: beforeState,
      outcome: "success",
    });
  })();

  return {
    executed: true,
    proposal_id: proposal.id,
    action: "escalate",
    escalation_id: escalationId,
    escalation_kind: kind,
    result_summary:
      `Recorded a ${kind} escalation (${escalationId}) on ${order.id} for ${reason.replace(/_/g, " ")}. ` +
      `No payment, order, or inventory state was modified.`,
    audit_id: auditId,
    before_state: JSON.parse(beforeState) as unknown,
    after_state: JSON.parse(beforeState) as unknown,
    as_of: now(),
  };
}

/** Eligibility as it stands right now, for an ineligible-refund evidence packet. */
function eligibilityAtExecute(
  queries: Queries,
  order: OrderRow,
  amountCents: number,
): EligibilityResult | undefined {
  const payment = queries.getPaymentsForOrder(order.id).find((p) => p.status === "captured");
  const customer = queries.getCustomer(order.customer_id);
  if (payment === undefined || customer === undefined) return undefined;
  return evaluateRefundEligibility({
    order,
    payment,
    customer,
    carrierExceptions: queries.getCarrierExceptionsForOrder(order.id),
    priorRefundActionKeys: queries.getExecutedRefundActionKeys(),
    amountCents,
  });
}

/* ==========================================================================
 * Registration
 * ========================================================================== */

export function registerWriteTools(
  server: McpServer,
  queries: Queries,
  options: InstrumentOptions,
): void {
  server.registerTool(
    "propose_resolution",
    {
      title: "Propose a resolution",
      description:
        "Create a resolution proposal for an order after investigating it with " +
        "get_order_timeline. This does NOT change anything — it validates the proposed " +
        "action against current state and returns a proposal_id plus a human-readable " +
        "plan for the analyst to confirm. Execution requires a separate call to " +
        "execute_resolution with that proposal_id. Valid actions: refund, escalate. " +
        "Refunds execute only for policy-eligible cases: at most $150.00, not exceeding " +
        "the amount paid, order no more than 30 days old, customer risk below 70, a " +
        "verified carrier exception on file, and no existing refund for the same action. " +
        "All other cases produce an escalation for human review — if you request a refund " +
        "that fails any check, this returns an executable escalate proposal explaining " +
        "which check failed, not an error. Payment-processor state is never modified: " +
        "suspected duplicate charges produce an evidence-bearing escalation, never a " +
        "retry, void, or processor-side refund. If the order is healthy, this returns " +
        "no_action_needed instead of inventing a fix.",
      inputSchema: ProposeResolutionInput,
    },
    instrumented<ProposeResolutionArgs, Record<string, unknown>>(
      "propose_resolution",
      options,
      (args) => {
        const result = proposeResolution(queries, args);
        return isToolError(result) ? fail(result) : ok(result);
      },
    ),
  );

  server.registerTool(
    "execute_resolution",
    {
      title: "Execute a resolution",
      description:
        "Execute a previously created proposal by its proposal_id. Requires that the " +
        "human analyst has confirmed the plan returned by propose_resolution. Each " +
        "proposal executes at most once (idempotent); execution fails if order state " +
        "changed since the proposal was created. Refunds execute only when the full " +
        "six-check refund policy still passes at execution time — the policy is " +
        "re-evaluated here and the proposal's earlier verdict is never trusted. Every " +
        "other outcome is an escalation, which records evidence for a human and changes " +
        "no order or payment state. All executions are audit-logged with before/after " +
        "state. There is no way to mutate order or payment state except through this tool.",
      inputSchema: ExecuteResolutionInput,
    },
    instrumented<ExecuteResolutionArgs, Record<string, unknown>>(
      "execute_resolution",
      options,
      (args, extra?: ToolExtra) => {
        const result = executeResolution(queries, args, actorFrom(extra));
        return isToolError(result) ? fail(result) : ok(result);
      },
    ),
  );
}
