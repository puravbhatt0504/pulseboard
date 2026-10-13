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
