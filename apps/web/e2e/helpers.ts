import { expect, type Browser, type Page } from "@playwright/test";

const PASSWORD = "password123";

let ip = 0;
/**
 * A browser context with its own client IP (the e2e API trusts one proxy hop), so sign-ups don't share the login
 * limit. Added by a route, not extraHTTPHeaders: a page-set header would need CORS preflight approval.
 */
export async function newContext(browser: Browser) {
  const ctx = await browser.newContext();
  const addr = `10.${process.pid % 256}.${(++ip >> 8) % 256}.${ip % 256}`;
  await ctx.route("http://localhost:4000/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": addr } }),
  );
  return ctx;
}

export async function signUp(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/boards");
}

export const column = (page: Page, title: string) => page.getByTestId("column").filter({ has: page.getByRole("heading", { name: title }) });

/** Two signed-up users in separate browser contexts; A owns a board with the given columns and B is a member (editor by default). */
export async function sharedBoard(browser: Browser, title: string, columns: string[], role: "editor" | "viewer" = "editor") {
  const ctxA = await newContext(browser);
  const ctxB = await newContext(browser);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`; // parallel workers can share a millisecond
  const emailA = `alice${stamp}@e2e.dev`;
  const emailB = `bob${stamp}@e2e.dev`;
  await signUp(a, emailA);
  await signUp(b, emailB);
  await a.getByPlaceholder("New board title").fill(title);
  await a.getByRole("button", { name: "Create board" }).click();
  await a.waitForURL(/\/boards\/[^/]+$/);
  for (const c of columns) {
    await a.getByPlaceholder("+ Add column").fill(c);
    await a.getByPlaceholder("+ Add column").press("Enter");
    await expect(column(a, c)).toBeVisible();
  }
  const invited = a.waitForResponse((r) => r.url().endsWith("/members") && r.status() === 201);
  await a.getByPlaceholder("Invite by email").fill(emailB);
  await a.locator('select[name="role"]').selectOption(role);
  await a.getByRole("button", { name: "Invite" }).click();
  await invited;
  return { a, b, ctxA, ctxB, stamp };
}
