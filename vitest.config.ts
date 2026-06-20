import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/",
        "build/",
        "**/*.test.ts",
        "scripts/",
        "*.config.*",
        // Entry point (server wiring; exercised by the integration suite) and the
        // type-only module have no meaningful unit-testable logic.
        "src/index.ts",
        "src/types.ts",
      ],
      thresholds: {
        // Per-directory thresholds on the testable logic, mirroring the
        // apple-notes-mcp standard. The server entry point and resource/prompt
        // wiring are covered by the integration suite instead.
        "src/services/**/*.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "src/tools/**/*.ts": { statements: 80, branches: 80, functions: 90, lines: 80 },
        "src/utils/**/*.ts": { statements: 70, branches: 65, functions: 80, lines: 70 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
