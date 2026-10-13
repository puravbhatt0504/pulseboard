import { expect, test } from "@playwright/test";
import { column, newContext, signUp } from "./helpers";

// The e2e API has no RelayQ, so this exercises the full-text half (the vector half is covered by search.test.ts).
test("searching the board finds a card by its words and opens it", async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await signUp(page, `search${Date.now()}${Math.random().toString(36).slice(2, 6)}@e2e.dev`);
  await page.getByPlaceholder("New board title").fill("Search");
  await page.getByRole("button", { name: "Create board" }).click();
  await page.waitForURL(/\/boards\/[^/]+$/);
  await page.getByPlaceholder("+ Add column").fill("Todo");
  await page.getByPlaceholder("+ Add column").press("Enter");
  for (const title of ["Renew the TLS certificates", "Plan the offsite"]) {
    await column(page, "Todo").getByPlaceholder("+ Add card").fill(title);
    await column(page, "Todo").getByPlaceholder("+ Add card").press("Enter");
    await expect(column(page, "Todo").getByText(title)).toBeVisible();
  }

  await page.getByLabel("Search cards").fill("certificate renewal");
  const results = page.getByTestId("search-results");
  await expect(results.getByRole("button")).toHaveText(["Renew the TLS certificates"]);
  await results.getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "Card" }).getByRole("heading")).toHaveText("Renew the TLS certificates");
});
