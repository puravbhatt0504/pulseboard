import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { signAccess } from "../auth/jwt.js";
import { cacheKey } from "./service.js";

const { app, prisma, redis } = makeTestApp();
afterAll(() => prisma.$disconnect());

async function makeUser() {
  const user = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } });
  return { id: user.id, auth: `Bearer ${signAccess({ userId: user.id })}` };
}

let owner: Awaited<ReturnType<typeof makeUser>>;
let viewer: Awaited<ReturnType<typeof makeUser>>;
let stranger: Awaited<ReturnType<typeof makeUser>>;
let boardId: string;

beforeAll(async () => {
  [owner, viewer, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()]);
  const res = await request(app).post("/boards").set("Authorization", owner.auth).send({ title: "Roadmap" });
  expect(res.status).toBe(201);
  boardId = res.body.id;
  await prisma.boardMember.create({ data: { boardId, userId: viewer.id, role: "viewer" } });
});

const get = (auth: string) => request(app).get(`/boards/${boardId}`).set("Authorization", auth);

describe("access", () => {
  it("401 without token", async () => {
    expect((await request(app).get("/boards")).status).toBe(401);
  });
  it("lists only the user's boards", async () => {
    const mine = await request(app).get("/boards").set("Authorization", owner.auth);
    expect(mine.body).toContainEqual({ id: boardId, title: "Roadmap", role: "owner" });
    const theirs = await request(app).get("/boards").set("Authorization", stranger.auth);
    expect(theirs.body.find((b: { id: string }) => b.id === boardId)).toBeUndefined();
  });
  it("non-member → 404 (same as a board that doesn't exist)", async () => {
    const res = await get(stranger.auth);
    expect(res.status).toBe(404);
    const missing = await request(app).get("/boards/nope").set("Authorization", stranger.auth);
    expect(res.body).toEqual(missing.body);
  });
  it("viewer can read but write → 403", async () => {
    expect((await get(viewer.auth)).status).toBe(200);
    const res = await request(app).post(`/boards/${boardId}/columns`).set("Authorization", viewer.auth).send({ title: "x" });
    expect(res.status).toBe(403);
  });
  it("non-member write → 404", async () => {
    const res = await request(app).post(`/boards/${boardId}/columns`).set("Authorization", stranger.auth).send({ title: "x" });
    expect(res.status).toBe(404);
  });
});

describe("cache", () => {
  it("hit returns the same body; a write invalidates it", async () => {
    await redis.del(cacheKey(boardId));
    const first = await get(owner.auth);
    expect(await redis.exists(cacheKey(boardId))).toBe(1);

    // Change the DB behind the API's back: a cache hit must still return the old body.
    await prisma.board.update({ where: { id: boardId }, data: { title: "Renamed" } });
    const second = await get(owner.auth);
    expect(second.body).toEqual(first.body);

    await request(app).post(`/boards/${boardId}/columns`).set("Authorization", owner.auth).send({ title: "Todo" });
    expect(await redis.exists(cacheKey(boardId))).toBe(0);
    const third = await get(owner.auth);
    expect(third.body.title).toBe("Renamed");
    expect(third.body.columns.map((c: { title: string }) => c.title)).toContain("Todo");
  });
});

describe("cards", () => {
  it("creates, moves across columns between neighbours, and returns them ordered", async () => {
    const col = (title: string) =>
      request(app).post(`/boards/${boardId}/columns`).set("Authorization", owner.auth).send({ title }).then((r) => r.body.id as string);
    const card = (columnId: string, title: string) =>
      request(app).post(`/columns/${columnId}/cards`).set("Authorization", owner.auth).send({ title }).then((r) => r.body);
    const a = await col("A");
    const b = await col("B");
    const a1 = await card(a, "a1");
    const b1 = await card(b, "b1");
    const b2 = await card(b, "b2");
    expect(b1.position < b2.position).toBe(true);

    const move = await request(app)
      .patch(`/cards/${a1.id}`)
      .set("Authorization", owner.auth)
      .send({ columnId: b, before: b1.id });
    expect(move.status).toBe(200);
    expect(move.body.position > b1.position && move.body.position < b2.position).toBe(true);
    // Siblings untouched (never renumbered).
    expect((await prisma.card.findUnique({ where: { id: b2.id } }))!.position).toBe(b2.position);

    const board = await get(owner.auth);
    const colB = board.body.columns.find((c: { id: string }) => c.id === b);
    expect(colB.cards.map((c: { title: string }) => c.title)).toEqual(["b1", "a1", "b2"]);

    // Only `after` given: lands directly above it.
    const top = await request(app).patch(`/cards/${b2.id}`).set("Authorization", owner.auth).send({ after: b1.id });
    expect(top.body.position < b1.position).toBe(true);
  });

  it("rejects bad moves with 400 and viewer moves with 403", async () => {
    const colId = (await prisma.column.findFirst({ where: { boardId } }))!.id;
    const c = await request(app).post(`/columns/${colId}/cards`).set("Authorization", owner.auth).send({ title: "z" });
    const self = await request(app).patch(`/cards/${c.body.id}`).set("Authorization", owner.auth).send({ before: c.body.id });
    expect(self.status).toBe(400);
    const byViewer = await request(app).patch(`/cards/${c.body.id}`).set("Authorization", viewer.auth).send({ title: "hijack" });
    expect(byViewer.status).toBe(403);
  });
});
