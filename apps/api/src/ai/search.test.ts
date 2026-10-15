import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { signAccess } from "../auth/jwt.js";
import { backfillEmbeddings, cardText, EMBED_DIMS, embedIfChanged, textHash, vectorLiteral } from "./embed.js";
import { rrf } from "./search.js";

const { app, prisma } = makeTestApp();

/** Unit vector along axis i (cosine 1 with itself, 0 with any other axis); mix() blends two axes. */
const axis = (i: number) => Array.from({ length: EMBED_DIMS }, (_, j) => (j === i ? 1 : 0));
const mix = (i: number, j: number, w: number) => axis(i).map((v, k) => v * w + axis(j)[k] * Math.sqrt(1 - w * w));

// Fake RelayQ: /jobs records enqueues; /embed answers from `queryVectors` (or fails when `embedDown`).
let relayq: Server;
let jobs: { type: string; payload: { items: { id: string; text: string }[] } }[] = [];
let embedDown = false;
const queryVectors = new Map<string, number[]>();
const body = (req: IncomingMessage) => new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)).on("end", () => r(d)); });

const ids = { owner: "", stranger: "", boardA: "", boardB: "", colA: "", colB: "" };
const auth = (userId: string) => `Bearer ${signAccess({ userId })}`;
const search = (boardId: string, q: string, userId = ids.owner) =>
  request(app).get(`/boards/${boardId}/search`).query({ q }).set("Authorization", auth(userId));

async function card(columnId: string, title: string, description = "", vector?: number[]) {
  const c = await prisma.card.create({ data: { columnId, title, description, position: `m${Math.random()}` } });
  if (vector) {
    await prisma.$executeRaw`INSERT INTO "CardEmbedding" ("cardId", "embedding", "contentHash", "model", "updatedAt")
      VALUES (${c.id}, ${vectorLiteral(vector)}::vector, ${textHash(cardText(c))}, 'voyage-3.5', now())`;
  }
  return c.id;
}

const signed = (payload: unknown, secret = "whsec") => {
  const raw = JSON.stringify(payload);
  return { raw, sig: createHmac("sha256", secret).update(raw).digest("hex") };
};

beforeAll(async () => {
  relayq = createServer(async (req, res) => {
    const b = JSON.parse(await body(req));
    if (req.url === "/embed") {
      if (embedDown) return res.writeHead(503).end();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: b.texts.map((t: string) => queryVectors.get(t) ?? axis(999)) }));
    }
    jobs.push(b);
    res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ jobId: `j${jobs.length}`, status: "queued" }));
  });
  await new Promise<void>((r) => relayq.listen(0, r));
  process.env.RELAYQ_URL = `http://localhost:${(relayq.address() as AddressInfo).port}`;
  process.env.RELAYQ_WEBHOOK_SECRET = "whsec";

  const user = () => prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } }).then((u) => u.id);
  [ids.owner, ids.stranger] = await Promise.all([user(), user()]);
  const board = (title: string) => prisma.board.create({ data: { title, members: { create: [{ userId: ids.owner, role: "owner" }] } } }).then((b) => b.id);
  [ids.boardA, ids.boardB] = await Promise.all([board("A"), board("B")]);
  ids.colA = (await prisma.column.create({ data: { boardId: ids.boardA, title: "c", position: "m" } })).id;
  ids.colB = (await prisma.column.create({ data: { boardId: ids.boardB, title: "c", position: "m" } })).id;
});

afterAll(() => {
  relayq.close();
  delete process.env.RELAYQ_URL;
});

beforeEach(() => {
  jobs = [];
  embedDown = false;
});

describe("rrf", () => {
  it("a card in both lists outranks cards in one; ties keep list order", () => {
    const [a, b, c] = ["a", "b", "c"].map((cardId) => ({ cardId, title: cardId }));
    expect(rrf([[a, b], [b, c]]).map((r) => r.cardId)).toEqual(["b", "a", "c"]);
    expect(rrf([[a, b], [b, c]])[0].score).toBeCloseTo(1 / 62 + 1 / 61);
  });
});

describe("GET /boards/:id/search", () => {
  it("non-member → 404; missing q → 400", async () => {
    expect((await search(ids.boardA, "anything", ids.stranger)).status).toBe(404);
    expect((await request(app).get(`/boards/${ids.boardA}/search`).set("Authorization", auth(ids.owner))).status).toBe(400);
  });

  it("never returns cards from another board, even with identical text and vectors", async () => {
    const mine = await card(ids.colA, "Printer on floor 3 jams", "", axis(1));
    const theirs = await card(ids.colB, "Printer on floor 3 jams", "", axis(1));
    queryVectors.set("printer jams", axis(1));
    const res = await search(ids.boardA, "printer jams");
    const found = res.body.map((r: { cardId: string }) => r.cardId);
    expect(found).toContain(mine);
    expect(found).not.toContain(theirs);
  });

  it("hybrid: a text-only match and a meaning-only match both come back; one matching both ranks first", async () => {
    const both = await card(ids.colA, "Refund the duplicate invoice", "", axis(2));
    const meaningOnly = await card(ids.colA, "Customer charged twice", "", mix(2, 3, 0.9));
    const wordsOnly = await card(ids.colA, "Invoice template font", "", axis(4));
    queryVectors.set("duplicate invoice", axis(2));
    const res = await search(ids.boardA, "duplicate invoice");
    expect(res.status).toBe(200);
    const order = res.body.map((r: { cardId: string }) => r.cardId);
    expect(order[0]).toBe(both);
    expect(order).toEqual(expect.arrayContaining([meaningOnly, wordsOnly]));
  });

  it("embeddings unavailable → full-text results only, still 200", async () => {
    const id = await card(ids.colA, "Rotate the staging certificates", "", axis(5));
    embedDown = true;
    const res = await search(ids.boardA, "certificates");
    expect(res.status).toBe(200);
    expect(res.body.map((r: { cardId: string }) => r.cardId)).toEqual([id]);
  });
});

describe("POST /boards/:id/cards/similar", () => {
  it("returns cards at or above the threshold only", async () => {
    const close = await card(ids.colA, "Login page times out", "", axis(10));
    await card(ids.colA, "Unrelated", "", axis(11));
    queryVectors.set("Sign-in page is slow\n", mix(10, 12, 0.95));
    const res = await request(app).post(`/boards/${ids.boardA}/cards/similar`).set("Authorization", auth(ids.owner)).send({ title: "Sign-in page is slow" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ cardId: close, title: "Login page times out", similarity: expect.closeTo(0.95, 3) }]);
    expect((await request(app).post(`/boards/${ids.boardA}/cards/similar`).set("Authorization", auth(ids.stranger)).send({ title: "x" })).status).toBe(404);
  });
});

describe("indexing", () => {
  it("unchanged text enqueues nothing; changed text enqueues one embed.batch; the callback stores it", async () => {
    const id = await card(ids.colA, "Write the release notes");
    expect(await embedIfChanged({ prisma }, id)).toBe(true);
    expect(jobs).toHaveLength(1);
    const [item] = jobs[0].payload.items;
    expect(item).toEqual({ id: `${id}:${textHash("Write the release notes\n")}`, text: "Write the release notes\n" });

    const { raw, sig } = signed({ items: [{ id: item.id, embedding: axis(20) }] });
    const cb = await request(app).post("/ai/embeddings/callback").set("content-type", "application/json").set("x-relayq-signature", sig).send(raw);
    expect(cb.status).toBe(204);
    expect(await prisma.cardEmbedding.count({ where: { cardId: id } })).toBe(1);

    expect(await embedIfChanged({ prisma }, id)).toBe(false); // same text: no job
    expect(jobs).toHaveLength(1);
    await prisma.card.update({ where: { id }, data: { title: "Write the release notes for 2.0" } });
    expect(await embedIfChanged({ prisma }, id)).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it("callback: stale text is skipped (still 204), bad signature → 401, wrong dimensions → 400", async () => {
    const id = await card(ids.colA, "Old title");
    const stale = signed({ items: [{ id: `${id}:${textHash("something else")}`, embedding: axis(21) }] });
    const post = (s: { raw: string; sig: string }) =>
      request(app).post("/ai/embeddings/callback").set("content-type", "application/json").set("x-relayq-signature", s.sig).send(s.raw);
    expect((await post(stale)).status).toBe(204);
    expect(await prisma.cardEmbedding.count({ where: { cardId: id } })).toBe(0);
    expect((await post({ ...stale, sig: "0".repeat(64) })).status).toBe(401);
    expect((await post(signed({ items: [{ id: `${id}:x`, embedding: [1, 2, 3] }] }))).status).toBe(400);
  });
});

describe("EMBED_BEDROCK_MODEL (Titan on Bedrock, no RelayQ)", () => {
  it("embeds in-process, tags the model, skips unchanged text, and never compares vectors across models", async () => {
    // Fake Bedrock runtime (HTTP/2, like the real client): /model/<id>/invoke → {embedding}.
    const calls: { url?: string; inputText: string; dimensions: number }[] = [];
    const fake = createHttp2Server((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c)).on("end", () => {
        calls.push({ url: req.url, ...JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: axis(7), inputTextTokenCount: 3 }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, r));
    const env = {
      EMBED_BEDROCK_MODEL: "amazon.titan-embed-text-v2:0",
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://localhost:${(fake.address() as AddressInfo).port}`,
      AWS_REGION: "ap-south-1",
      AWS_ACCESS_KEY_ID: "AKIATESTONLY", // test-only fake keys: requests go to the local fake server
      AWS_SECRET_ACCESS_KEY: "test-only",
    };
    Object.assign(process.env, env);
    try {
      const enqueuedBefore = jobs.length;
      const titan = await card(ids.colA, "Titan card", "embedded on bedrock");
      const voyage = await card(ids.colA, "Voyage twin", "", axis(7)); // same vector, other model

      expect(await embedIfChanged({ prisma }, titan)).toBe(true);
      expect(calls[0]).toMatchObject({ url: "/model/amazon.titan-embed-text-v2%3A0/invoke", inputText: cardText({ title: "Titan card", description: "embedded on bedrock" }), dimensions: 1024 });
      expect((await prisma.cardEmbedding.findUnique({ where: { cardId: titan } }))?.model).toBe("amazon.titan-embed-text-v2:0");
      expect(await embedIfChanged({ prisma }, titan)).toBe(false); // unchanged text, same model
      expect(jobs.length).toBe(enqueuedBefore); // nothing went to RelayQ

      const hits = (await search(ids.boardA, "zzqx-no-text-match")).body.map((h: { cardId: string }) => h.cardId);
      expect(hits).toContain(titan);
      expect(hits).not.toContain(voyage);

      // Backfill: every card without a Titan vector gets one (the voyage twin included); a second run has nothing to do.
      expect(await backfillEmbeddings({ prisma })).toBeGreaterThan(0);
      expect((await prisma.cardEmbedding.findUnique({ where: { cardId: voyage } }))?.model).toBe("amazon.titan-embed-text-v2:0");
      expect(await backfillEmbeddings({ prisma })).toBe(0);
    } finally {
      fake.close();
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
});

