/**
 * Tool-call instrumentation wrapper (CONVENTIONS.md B3, B5).
 *
 * Owns requestId generation, timing, and the single structured log line per tool
 * call. Handlers log nothing themselves except `warn` on a rejected write.
 *
 * The pino destination is injectable rather than a module singleton, because one
 * Tier-1 test asserts that a rejected propose_resolution emits a `warn` and writes
 * no audit row — that assertion needs a real, readable sink, not a spy.
 */
import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolError, type ToolError } from "./errors.js";

export interface InstrumentOptions {
  logger: Logger;
}

/**
 * Build the application logger.
 *
 * `redact` covers the Authorization header; the tokenized URL path is handled by a
 * request serializer in index.ts, because the secret sits in `req.url` there and
 * redaction paths cannot reach into a string.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "headers.authorization", "authorization"],
      censor: "[REDACTED]",
    },
  });
}

/** A handler returns either a value to serialize, or a structured tool error. */
export type HandlerResult<T> = { ok: true; value: T } | { ok: false; error: ToolError };

/**
 * The SDK's per-call context. Typed structurally rather than imported so the
 * handler signature stays readable, and so we depend only on the one field we use.
 */
export interface ToolExtra {
  _meta?: Record<string, unknown> | undefined;
}

/**
 * Actor attribution for the audit trail.
 *
 * CONVENTIONS.md A2.1: this is client-asserted and is NOT authentication. It
 * records who the caller claims to be, which is useful for an audit trail and
 * worthless as an access control.
 */
export function actorFrom(extra: ToolExtra | undefined): string {
  const claimed = extra?._meta?.["actor"];
  return typeof claimed === "string" && claimed.trim().length > 0 ? claimed : "unattributed";
}

export const ok = <T,>(value: T): HandlerResult<T> => ({ ok: true, value });
export const fail = (error: ToolError): HandlerResult<never> => ({ ok: false, error });

/** Serialize any tool payload into the single-JSON-text-block shape TOOLS.md specifies. */
function toCallToolResult(payload: unknown, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Wrap a tool handler so every call is logged exactly once.
 *
 * Three outcomes, three treatments:
 *   - success  → `info`, result serialized.
 *   - structured rejection → `warn`, error body serialized with `isError: true`.
 *     This is the path a rejected propose_resolution takes, and the reason the
 *     logger is injectable.
 *   - unexpected throw → `error` with the full stack SERVER-SIDE only; the client
 *     gets a generic message. Stack traces, file paths and SQL never cross the
 *     transport (CONVENTIONS.md A3).
 */
export function instrumented<TArgs, TResult>(
  toolName: string,
  options: InstrumentOptions,
  handler: (args: TArgs) => HandlerResult<TResult> | Promise<HandlerResult<TResult>>,
): (args: TArgs, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args: TArgs, extra: ToolExtra): Promise<CallToolResult> => {
    const requestId = randomUUID();
    const actor = actorFrom(extra);
    const startedAt = performance.now();

    try {
      const result = await handler(args);
      const durationMs = Math.round(performance.now() - startedAt);

      if (result.ok) {
        options.logger.info({ requestId, toolName, actor, input: args, durationMs, outcome: "success" });
        return toCallToolResult(result.value, false);
      }

      options.logger.warn({
        requestId,
        toolName,
        actor,
        input: args,
        durationMs,
        outcome: "rejected",
        errorCode: result.error.error_code,
      });
      return toCallToolResult(result.error, true);
    } catch (cause) {
      const durationMs = Math.round(performance.now() - startedAt);
      // Full detail stays here. The client sees none of it.
      options.logger.error(
        { requestId, toolName, actor, durationMs, outcome: "error", err: cause },
        "unhandled error in tool handler",
      );
      return toCallToolResult(
        toolError(
          "internal_error",
          `The ${toolName} tool failed unexpectedly. Reference ${requestId}.`,
          "Retry the call. If it keeps failing, report the reference id to engineering.",
        ),
        true,
      );
    }
  };
}
