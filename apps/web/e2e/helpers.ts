import { expect, type Browser, type Page } from "@playwright/test";

const PASSWORD = "password123";

export async function signUp(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/boards");
}

export const column = (page: Page, title: string) => page.getByTestId("column").filter({ has: page.getByRole("heading", { name: title }) });

/** Two signed-up users in separate browser contexts; A owns a board with the given columns and B is an editor on it. */
export async function sharedBoard(browser: Browser, title: string, columns: string[]) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const stamp = Date.now();
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
  await a.getByRole("button", { name: "Invite" }).click();
  await invited;
  return { a, b, ctxA, ctxB, stamp };
}
