import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { signAccess } from "../auth/jwt.js";
import { etaColumn } from "./eta.js";

const { app, prisma } = makeTestApp();

// Fake ml/eta server: records the features it was sent.
let eta: Server;
let status = 200;
const sent: Record<string, unknown>[] = [];
const ids = { owner: "", stranger: "", board: "", doing: "", done: "", card: "", finished: "" };
const getEta = (cardId: string, userId = ids.owner) => request(app).get(`/cards/${cardId}/eta`).set("Authorization", `Bearer ${signAccess({ userId })}`);

beforeAll(async () => {
  eta = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      sent.push(JSON.parse(raw));
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ p50Hours: 20.5, p90Hours: 61 }));
    });
  });
  await new Promise<void>((r) => eta.listen(0, r));
  process.env.ETA_URL = `http://localhost:${(eta.address() as AddressInfo).port}`;

  const user = () => prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } }).then((u) => u.id);
  [ids.owner, ids.stranger] = await Promise.all([user(), user()]);
  ids.board = (await prisma.board.create({ data: { title: "ETA", members: { create: [{ userId: ids.owner, role: "owner" }] } } })).id;
  ids.doing = (await prisma.column.create({ data: { boardId: ids.board, title: "In progress", position: "b" } })).id;
  ids.done = (await prisma.column.create({ data: { boardId: ids.board, title: "Done", position: "c" } })).id;

  // A card finished 10 h after it was created, by the owner.
  const t0 = new Date("2026-10-12T08:00:00Z"); // a Monday
  ids.finished = (await prisma.card.create({ data: { columnId: ids.done, title: "old", position: "m", createdAt: t0, assigneeId: ids.owner } })).id;
  await prisma.activity.create({
    data: { boardId: ids.board, userId: ids.owner, type: "card.moved", data: { cardId: ids.finished, columnId: ids.done }, createdAt: new Date(t0.getTime() + 10 * 36e5) },
  });
  ids.card = (await prisma.card.create({
    data: { columnId: ids.doing, title: "new", description: "12345", position: "m", labels: ["bug", "docs"], priority: "urgent", assigneeId: ids.owner, createdAt: new Date("2026-10-14T09:00:00Z") },
  })).id;
});

afterAll(() => {
  eta.close();
  delete process.env.ETA_URL;
});

describe("etaColumn", () => {
  it("maps column titles to the model's columns; Done → null", () => {
    expect(["Backlog", "To do", "In progress", "Code review", "Done", "Ideas"].map(etaColumn)).toEqual(["backlog", "todo", "doing", "review", null, "todo"]);
  });
});

describe("GET /cards/:id/eta", () => {
  it("sends the card's features and returns the model's p50/p90", async () => {
    const res = await getEta(ids.card);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ p50Hours: 20.5, p90Hours: 61 });
    expect(sent.at(-1)).toEqual({
      column: "doing",
      labels: ["bug", "urgent"], // docs isn't a model label; urgent priority → the "urgent" label
      description_length: 5,
      comments: 0,
      checklist_items: 0,
      assignee_median_hours: 10,
      board_median_hours: 10,
      day_of_week: 2, // Wednesday
      open_cards_assignee: 1, // the finished card is in Done
    });
  });

  it("Done card → {done: true} without calling the model; non-member 404; model down or unset → 503", async () => {
    const before = sent.length;
    expect((await getEta(ids.finished)).body).toEqual({ done: true });
    expect(sent.length).toBe(before);
    expect((await getEta(ids.card, ids.stranger)).status).toBe(404);
    status = 500;
    expect((await getEta(ids.card)).status).toBe(503);
    status = 200;
    const url = process.env.ETA_URL;
    delete process.env.ETA_URL;
    expect((await getEta(ids.card)).status).toBe(503);
    process.env.ETA_URL = url;
  });
});
