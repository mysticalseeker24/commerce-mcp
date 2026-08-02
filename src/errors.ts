/**
 * The single error shape used everywhere (CONVENTIONS.md B4).
 *
 * Errors are returned to the client with `isError: true` per the MCP spec — never
 * thrown across the transport. `hint` is not decoration: it tells the agent which
 * tool to call next, which is why every rejection must supply one.
 */

/** Machine-stable error codes. Snake_case, never renamed once shipped. */
export const ERROR_CODES = [
  "unknown_proposal",
  "already_executed",
  "stale_proposal",
  "amount_exceeds_refundable",
  "amount_exceeds_cap",
  "invalid_action_for_state",
  "no_action_needed",
  "not_found",
  "invalid_input",
  "unauthorized",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  error_code: ErrorCode;
  message: string;
  /** Always tells the agent the correct next call. */
  hint: string;
}

export function toolError(code: ErrorCode, message: string, hint: string): ToolError {
  return { error_code: code, message, hint };
}

/**
 * Narrows a "payload or error" return.
 *
 * A plain `"error_code" in value` check does not narrow against
 * `Record<string, unknown>`, because that type is permitted to carry the key —
 * so the guard verifies the shape rather than merely the key's presence.
 */
export function isToolError(value: object): value is ToolError {
  return (
    "error_code" in value &&
    typeof (value as { error_code: unknown }).error_code === "string" &&
    "hint" in value
  );
}
