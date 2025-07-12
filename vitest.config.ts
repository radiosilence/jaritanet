import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
    globals: true,
    typecheck: {
      enabled: true,
    },
  },
});
