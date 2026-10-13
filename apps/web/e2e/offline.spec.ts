import { expect, test } from "@playwright/test";
import { column, sharedBoard } from "./helpers";

test("A edits a description offline, B edits it online; after A reconnects both see both edits", async ({ browser }) => {
  const { a, b, ctxA } = await sharedBoard(browser, "Offline", ["Todo"]);
  await column(a, "Todo").getByPlaceholder("+ Add card").fill("Spec");
  await column(a, "Todo").getByPlaceholder("+ Add card").press("Enter");
  await b.goto(a.url());

  for (const p of [a, b]) {
    await column(p, "Todo").getByTestId("card").click();
    await expect(p.getByTestId("description-status")).toHaveText("live");
  }
  const editorA = a.getByTestId("description-editor");
  const editorB = b.getByTestId("description-editor");

  await ctxA.setOffline(true);
  await expect(a.getByTestId("description-status")).toHaveText(/offline/);
  await editorA.click();
  await a.keyboard.type("written offline by A");
  await editorB.click();
  await b.keyboard.press("Enter");
  await b.keyboard.type("written online by B");
  await expect(editorB).toContainText("written online by B");
  await expect(editorB).not.toContainText("written offline by A");

  await ctxA.setOffline(false);
  await expect(a.getByTestId("description-status")).toHaveText("live");
  for (const editor of [editorA, editorB]) {
    await expect(editor).toContainText("written offline by A");
    await expect(editor).toContainText("written online by B");
  }

  // Persisted: a reload (fresh page, server state + IndexedDB) still has both.
  await b.reload();
  await column(b, "Todo").getByTestId("card").click();
  await expect(editorB).toContainText("written offline by A");
  await expect(editorB).toContainText("written online by B");
});

test("board writes made offline are queued and replayed in order on reconnect", async ({ browser }) => {
  const { a, b, ctxA } = await sharedBoard(browser, "Outbox", ["Todo"]);
  await b.goto(a.url());
  await expect(column(b, "Todo")).toBeVisible();
  await ctxA.setOffline(true);
  // A column, then a card in it: the card's request names the column's temporary id until replay swaps in the real one.
  await a.getByPlaceholder("+ Add column").fill("Later");
  await a.getByPlaceholder("+ Add column").press("Enter");
  await column(a, "Later").getByPlaceholder("+ Add card").fill("queued card");
  await column(a, "Later").getByPlaceholder("+ Add card").press("Enter");
  await expect(column(a, "Later").getByTestId("card")).toHaveText("queued card");
  await expect(column(b, "Later")).toHaveCount(0);

  // The card is the last queued write; 201 means its column id was rewritten to the real one first.
  const replayed = a.waitForResponse((r) => /\/columns\/[^/]+\/cards$/.test(r.url()) && r.request().method() === "POST");
  await ctxA.setOffline(false);
  expect((await replayed).status()).toBe(201);
  await b.reload(); // columns aren't broadcast, only cards
  await expect(column(b, "Later").getByTestId("card")).toHaveText("queued card");
  await a.reload();
  await expect(column(a, "Later").getByTestId("card")).toHaveText("queued card");
});

test("an offline write the server rejects on replay is dropped with a message, not retried", async ({ browser }) => {
  const { a, b, ctxB } = await sharedBoard(browser, "Rejected", ["Todo"], "viewer");
  await b.goto(a.url());
  await expect(column(b, "Todo")).toBeVisible();
  await ctxB.setOffline(true);
  await column(b, "Todo").getByPlaceholder("+ Add card").fill("viewer card");
  await column(b, "Todo").getByPlaceholder("+ Add card").press("Enter");
  await expect(column(b, "Todo").getByTestId("card")).toHaveText("viewer card");

  await ctxB.setOffline(false);
  const dropped = b.getByText(/change made offline was dropped \(403/);
  await expect(dropped).toBeVisible();
  await expect(column(b, "Todo").getByTestId("card")).toHaveCount(0);
  await b.reload(); // queue is empty: nothing is sent again
  await expect(column(b, "Todo")).toBeVisible();
  await expect(dropped).toHaveCount(0);
  await expect(column(a, "Todo").getByTestId("card")).toHaveCount(0);
});
