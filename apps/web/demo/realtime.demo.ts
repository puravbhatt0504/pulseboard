import { expect, test, type Browser, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { column } from "../e2e/helpers";

// Two people on one board, recorded side by side: cards appear live, a drag moves on both screens with the
// other person's cursor, and both type into one card description with named carets.
const SIZE = { width: 960, height: 600 };
const PASSWORD = "demo-password-123"; // throwaway local account on the e2e server's fresh database
const pause = (p: Page, ms = 1200) => p.waitForTimeout(ms);

let ip = 0;
async function person(browser: Browser, name: string, color: string) {
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: "demo/out", size: SIZE } });
  const addr = `10.9.0.${++ip}`; // own client IP per person, as in e2e/helpers.ts
  await ctx.route("http://localhost:4000/**", (r) => r.continue({ headers: { ...r.request().headers(), "x-forwarded-for": addr } }));
  // Name tag in the corner of every page, so the viewer knows whose screen is whose.
  await ctx.addInitScript(([name, color]) => {
    addEventListener("DOMContentLoaded", () => {
      const tag = document.createElement("div");
      tag.textContent = `${name}'s screen`;
      tag.style.cssText = `position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 12px;border-radius:999px;font:600 13px system-ui;color:#fff;background:${color};pointer-events:none`;
      document.body.appendChild(tag);
      const hide = document.createElement("style"); // Next.js dev-mode badge
      hide.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(hide);
    });
  }, [name, color]);
  const page = await ctx.newPage();
  const started = Date.now();
  const email = `${name.toLowerCase()}@demo.test`;
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/boards");
  return { page, ctx, email, started };
}

test("realtime demo", async ({ browser }) => {
  const alice = await person(browser, "Alice", "#7c3aed");
  const bob = await person(browser, "Bob", "#0891b2");
  const a = alice.page;
  const b = bob.page;

  // Setup (trimmed out of the video): Alice's board with three columns and two cards, Bob invited.
  await a.getByPlaceholder("New board title").fill("Launch plan");
  await a.getByRole("button", { name: "Create board" }).click();
  await a.waitForURL(/\/boards\/[^/]+$/);
  for (const c of ["To do", "In progress", "Done"]) {
    await a.getByPlaceholder("+ Add column").fill(c);
    await a.getByPlaceholder("+ Add column").press("Enter");
    await expect(column(a, c)).toBeVisible();
  }
  for (const t of ["Update API docs for v2", "Set up CI pipeline"]) {
    await column(a, "To do").getByPlaceholder("+ Add card").fill(t);
    await column(a, "To do").getByPlaceholder("+ Add card").press("Enter");
  }
  const invited = a.waitForResponse((r) => r.url().endsWith("/members") && r.status() === 201);
  await a.getByPlaceholder("Invite by email").fill(bob.email);
  await a.getByRole("button", { name: "Invite" }).click();
  await invited;
  await a.getByPlaceholder("Invite by email").blur();
  await b.goto(a.url());
  await expect(b.getByTestId("presence-avatar")).toHaveCount(2);

  // --- the part that's shown ---
  const showFrom = Date.now();
  await pause(a, 1500);

  // 1. Alice adds a card; it appears on Bob's screen.
  const aliceAdd = column(a, "To do").getByPlaceholder("+ Add card");
  await aliceAdd.click();
  await aliceAdd.pressSequentially("Checkout fails for carts over 50 items", { delay: 45 });
  await aliceAdd.press("Enter");
  await expect(column(b, "To do").getByText("Checkout fails for carts over 50 items")).toBeVisible();
  await pause(a);

  // 2. Bob adds one; it appears on Alice's.
  const bobAdd = column(b, "In progress").getByPlaceholder("+ Add card");
  await bobAdd.click();
  await bobAdd.pressSequentially("Add dark mode", { delay: 60 });
  await bobAdd.press("Enter");
  await expect(column(a, "In progress").getByText("Add dark mode")).toBeVisible();
  await pause(a);

  // 3. Alice drags a card to Done; Bob sees her cursor carry it there.
  const card = column(a, "To do").getByText("Set up CI pipeline");
  const from = (await card.boundingBox())!;
  const to = (await column(a, "Done").boundingBox())!;
  await a.mouse.move(from.x + 20, from.y + 10, { steps: 10 });
  await pause(a, 400);
  await a.mouse.down();
  await a.mouse.move(from.x + 40, from.y + 20, { steps: 5 });
  await a.mouse.move(to.x + 90, to.y + 60, { steps: 40 });
  await a.mouse.up();
  await expect(column(b, "Done").getByText("Set up CI pipeline")).toBeVisible();
  await a.mouse.move(to.x + 40, to.y + 160, { steps: 20 });
  await pause(a, 1500);

  // 4. Both open the checkout card and type into its description at the same time: named carets.
  for (const p of [a, b]) {
    await column(p, "To do").getByText("Checkout fails for carts over 50 items").click();
    await expect(p.getByTestId("description-status")).toHaveText("live");
  }
  await pause(a, 600);
  await a.getByTestId("description-editor").click();
  await a.keyboard.type("Repro: add 51 items, press Checkout, API returns 500.", { delay: 40 });
  await expect(b.getByTestId("description-editor")).toContainText("returns 500."); // Alice's text has reached Bob
  await pause(a, 500);
  const ed = b.getByTestId("description-editor");
  // A real click just past the last character puts Bob's caret at the end of Alice's text. Late sync updates can
  // move it back, so check where the caret is and click again until it stays at the end.
  const atEnd = () =>
    ed.evaluate((el) => {
      // Skip the other person's caret label (a non-editable widget with their name in it).
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, (n) =>
        n.parentElement!.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      );
      let last: Text | null = null;
      while (walk.nextNode()) last = walk.currentNode as Text;
      const r = document.createRange();
      r.setStart(last!, last!.length);
      const rect = r.getBoundingClientRect();
      const sel = getSelection()!;
      return { x: rect.right + 1, y: rect.top + rect.height / 2, ok: sel.anchorNode === last && sel.anchorOffset === last!.length };
    });
  await b.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    const end = await atEnd();
    if (i === 0) await b.mouse.move(end.x - 60, end.y + 30, { steps: 10 });
    await b.mouse.click(end.x, end.y);
    await b.waitForTimeout(400);
    if ((await atEnd()).ok) break;
  }
  expect((await atEnd()).ok).toBe(true);
  await b.keyboard.press("Enter");
  await b.keyboard.type("Started after Monday's cart release. I'll take it.", { delay: 45 });
  await expect(a.getByTestId("description-editor")).toContainText("I'll take it.");
  await pause(a, 2500);

  const showTo = Date.now();
  const videoA = await a.video()!.path();
  const videoB = await b.video()!.path();
  await alice.ctx.close();
  await bob.ctx.close();
  // Trim points per recording (each started when its context opened).
  writeFileSync(
    "demo/out/cut.json",
    JSON.stringify({
      a: { file: videoA, from: (showFrom - alice.started) / 1000 },
      b: { file: videoB, from: (showFrom - bob.started) / 1000 },
      duration: (showTo - showFrom) / 1000,
    }),
  );
});
