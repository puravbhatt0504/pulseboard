import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
    env: { JWT_ACCESS_SECRET: "test-access", JWT_REFRESH_SECRET: "test-refresh" },
    fileParallelism: false, // tests share one database
    testTimeout: 20_000,
  },
});
