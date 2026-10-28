import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";

// Vitest config for unit + integration tests.
// - Uses the same `@/*` alias as the app (src/*).
// - jsdom + testing-library for anything DOM-related.
// - Global env vars that unit/integration tests need (no real secrets; the
//   MockProvider/MockSource are the defaults per the test-discipline rules).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    env: {
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://127.0.0.1:27017/shoppilot-test",
    },
    // Integration tests may touch a real (test) DB; give them room.
    testTimeout: 15_000,
    // Run e2e separately via Playwright, not Vitest.
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
