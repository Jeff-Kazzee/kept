import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ui/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // A hook or teardown that never settles fails instead of holding the
    // run open. Tests that start a server or a build set their own longer
    // limits.
    hookTimeout: 30_000,
    teardownTimeout: 15_000,
  },
});
