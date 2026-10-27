import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ui/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
  },
});
