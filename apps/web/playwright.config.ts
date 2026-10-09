import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    {
      // Locally: throwaway Postgres + Redis mock. CI overrides via E2E_API_COMMAND to use service containers.
      command: process.env.E2E_API_COMMAND ?? "npm run e2e:server",
      cwd: "../api",
      url: "http://localhost:4000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
    },
    {
      command: process.env.CI ? "npm run build && npm run start" : "npm run dev",
      url: "http://localhost:3000/login",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
