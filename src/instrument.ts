/**
 * Tool-call instrumentation wrapper (CONVENTIONS.md B3, B5).
 *
 * Owns requestId generation, timing, and the single structured log line per tool
 * call. Handlers log nothing themselves except `warn` on a rejected write.
 *
 * The pino destination is injectable rather than a module singleton, because one
 * Tier-1 test asserts that a rejected propose_resolution emits a `warn` and writes
 * no audit row — that assertion needs a real, readable sink, not a spy.
 *
 * Populated in Phase 2.
 */
import type { Logger } from "pino";

export interface ToolCallLog {
  requestId: string;
  toolName: string;
  actor: string;
  durationMs: number;
  outcome: "success" | "error";
}

export interface InstrumentOptions {
  logger: Logger;
}

/**
 * Wrap a tool handler so every call is logged once and unexpected throws become a
 * generic client-facing error plus a full server-side log. Error messages returned
 * to clients never carry stack traces, file paths, or SQL (CONVENTIONS.md A3).
 */
export function instrumented<TArgs, TResult>(
  _toolName: string,
  _options: InstrumentOptions,
  _handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  throw new Error("instrumented() is not implemented yet — see PLAN.md Phase 2");
}
