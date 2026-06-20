import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests live under test/ and run against a REAL osxphotos/Photos
// library. They are NOT part of the default `npm test` (unit) run — invoke
// them explicitly with `npm run test:integration` (or via the vitest CLI:
// `npx vitest run --config vitest.integration.config.ts`).
//
// The live block self-skips when osxphotos/Photos is unavailable (e.g. CI
// runners with no library), so this suite is safe to run anywhere.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
