import { expect, test } from "@playwright/test";
import { column, signUp } from "./helpers";

test("A drags a card and B sees it move and sees A's cursor, without reload", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const stamp = Date.now();
  const emailA = `alice${stamp}@e2e.dev`;
  const emailB = `bob${stamp}@e2e.dev`;
  await signUp(a, emailA);
  await signUp(b, emailB);

  // A sets up a board with two columns and a card, then invites B.
  await a.getByPlaceholder("New board title").fill("Sprint");
  await a.getByRole("button", { name: "Create board" }).click();
  await a.waitForURL(/\/boards\/[^/]+$/);
  for (const title of ["Todo", "Done"]) {
    await a.getByPlaceholder("+ Add column").fill(title);
    await a.getByPlaceholder("+ Add column").press("Enter");
    await expect(column(a, title)).toBeVisible();
  }
  await column(a, "Todo").getByPlaceholder("+ Add card").fill("Write tests");
  await column(a, "Todo").getByPlaceholder("+ Add card").press("Enter");
  await expect(column(a, "Todo").getByTestId("card")).toHaveText("Write tests");

  const invited = a.waitForResponse((r) => r.url().endsWith("/members") && r.status() === 201);
  await a.getByPlaceholder("Invite by email").fill(emailB);
  await a.getByRole("button", { name: "Invite" }).click();
  await invited;

  // B opens the same board; both see each other in presence.
  await b.goto(a.url());
  await expect(column(b, "Todo").getByTestId("card")).toHaveText("Write tests");
  await expect(a.getByTestId("presence-avatar")).toHaveCount(2);
  await expect(b.getByTestId("presence-avatar")).toHaveCount(2);

  // A drags the card into Done.
  const from = (await column(a, "Todo").getByTestId("card").boundingBox())!;
  const to = (await column(a, "Done").boundingBox())!;
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 10, { steps: 5 });
  await a.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await a.mouse.up();

  await expect(column(a, "Done").getByTestId("card")).toHaveText("Write tests");
  // B: no reload, card arrives via socket.
  await expect(column(b, "Done").getByTestId("card")).toHaveText("Write tests");
  await expect(column(b, "Todo").getByTestId("card")).toHaveCount(0);

  // A moves the pointer over the board; B renders A's cursor.
  await a.mouse.move(400, 400);
  await a.mouse.move(450, 420, { steps: 10 });
  const cursor = b.locator('[data-testid^="cursor-"]');
  await expect(cursor).toBeVisible();
  await expect(cursor).toContainText(`alice${stamp}`);
});
