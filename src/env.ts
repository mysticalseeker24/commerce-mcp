/**
 * Environment parsing, validated once at boot.
 *
 * CONVENTIONS.md A3: a missing `MCP_BEARER_TOKEN` crashes loudly rather than
 * defaulting to anything. Failing at boot is strictly better than serving
 * operational tools with an auth check that silently compares against `undefined`.
 */
import { z } from "zod";

const EnvSchema = z.object({
  MCP_BEARER_TOKEN: z
    .string()
    .min(16, "MCP_BEARER_TOKEN must be at least 16 characters"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PATH: z.string().min(1).default("./commerce.db"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  /**
   * Mounts POST /mcp/<token> when true. Off by default: credentials in URLs reach
   * proxy logs, browser history, and Referer. See CONVENTIONS.md A2.5 — this exists
   * only because Claude's `static_headers` auth is Beta and org-admin gated.
   */
  ALLOW_URL_TOKEN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate. Throws a readable aggregate error listing every bad or
 * missing variable at once, rather than failing on the first.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}
