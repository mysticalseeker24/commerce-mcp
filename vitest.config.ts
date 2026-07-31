import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each suite builds its own in-memory DB via createDb(':memory:'); running
    // files in isolated forks keeps one suite's mutations out of another's.
    pool: "forks",
    restoreMocks: true,
  },
});
