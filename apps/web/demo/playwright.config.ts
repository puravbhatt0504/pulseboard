import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import base from "../playwright.config";

// Records the realtime demo video (not a test): npx playwright test -c demo/playwright.config.ts
// Same local servers as e2e; demo/make-video.mjs then stitches the two recordings side by side.
export default defineConfig({
  ...base,
  // cwd resolves from this file's folder, one level deeper than the base config.
  webServer: (base.webServer as Extract<PlaywrightTestConfig["webServer"], unknown[]>).map((s) => ({ ...s, cwd: s.cwd ? `../${s.cwd}` : ".." })),
  testDir: ".",
  testMatch: "realtime.demo.ts",
  timeout: 180_000,
  retries: 0,
  use: { baseURL: "http://localhost:3000", viewport: { width: 960, height: 600 } },
});
