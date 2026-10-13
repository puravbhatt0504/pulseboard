import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { signAccess } from "../auth/jwt.js";
import { enqueueDigests } from "./digest.js";
import { createHmac } from "node:crypto";

const { app, prisma } = makeTestApp();

// Fake RelayQ: records every request, answers 202 {jobId}.
type Captured = { auth?: string; body: any };
let captured: Captured[] = [];
let jobSeq = 0; // job ids are Export primary keys, so they must stay unique across tests
let relayq: Server;
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c)).on("end", () => resolve(data));
  });

let owner: { id: string; email: string; auth: string };
let editor: { id: string; email: string; auth: string };
let boardId: string;
let cardId: string;

beforeAll(async () => {
  relayq = createServer(async (req, res) => {
    captured.push({ auth: req.headers.authorization, body: JSON.parse(await readBody(req)) });
    res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ jobId: `job-${++jobSeq}`, status: "queued" }));
  });
  await new Promise<void>((r) => relayq.listen(0, r));

  const mk = async () => {
    const u = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } });
    return { id: u.id, email: u.email, auth: `Bearer ${signAccess({ userId: u.id })}` };
  };
  owner = await mk();
  editor = await mk();
  const board = await prisma.board.create({
    data: { title: "Jobs", members: { create: [{ userId: owner.id, role: "owner" }, { userId: editor.id, role: "editor" }] } },
  });
  boardId = board.id;
  const col = await prisma.column.create({ data: { boardId, title: "c", position: "m" } });
  cardId = (await prisma.card.create({ data: { columnId: col.id, title: "card", position: "m" } })).id;
});

beforeEach(() => {
  captured = [];
  process.env.RELAYQ_URL = `http://localhost:${(relayq.address() as AddressInfo).port}`;
  process.env.RELAYQ_API_KEY = "rq_test";
});

afterAll(async () => {
  relayq.close();
  await prisma.$disconnect();
});

describe("POST /boards/:id/export", () => {
  it("enqueues board.export with the RelayQ payload shape → 202 {jobId}", async () => {
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({ format: "csv" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: expect.stringMatching(/^job-\d+$/) });
    expect(captured).toEqual([
      {
        auth: "Bearer rq_test",
        body: {
          type: "board.export",
          payload: { boardId, format: "csv", callbackUrl: `http://localhost:4000/boards/${boardId}/export/callback` },
        },
      },
    ]);
  });

  it("RelayQ unreachable → 503, not 500", async () => {
    process.env.RELAYQ_URL = "http://127.0.0.1:1";
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({});
    expect(res.status).toBe(503);
  });

  it("RelayQ 5xx → 503", async () => {
    const down = createServer((_req, res) => res.writeHead(500).end());
    await new Promise<void>((r) => down.listen(0, r));
    process.env.RELAYQ_URL = `http://localhost:${(down.address() as AddressInfo).port}`;
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({});
    down.close();
    expect(res.status).toBe(503);
  });

  it("bad format → 400, nothing enqueued", async () => {
    const res = await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({ format: "xml" });
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /cards/:id/attachments/presign", () => {
  beforeAll(() => {
    Object.assign(process.env, { S3_BUCKET: "pb-test", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" });
  });
  const presign = (body: object) =>
    request(app).post(`/cards/${cardId}/attachments/presign`).set("Authorization", editor.auth).send(body);

  it("returns a signed PUT url and key for a PDF", async () => {
    const res = await presign({ filename: "spec v2.pdf", contentType: "application/pdf", size: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(new RegExp(`^attachments/${cardId}/[0-9a-f-]+-spec_v2\\.pdf$`));
    const url = new URL(res.body.url);
    expect(url.hostname).toContain("pb-test");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
  it("rejects application/x-msdownload with 400", async () => {
    expect((await presign({ filename: "x.exe", contentType: "application/x-msdownload", size: 10 })).status).toBe(400);
  });
  it("rejects > 10 MB with 400", async () => {
    expect((await presign({ filename: "big.png", contentType: "image/png", size: 10 * 1024 * 1024 + 1 })).status).toBe(400);
  });
});

describe("nightly digest", () => {
  it("enqueues one email.digest per member about others' activity, with a per-day idempotency key", async () => {
    await prisma.activity.create({ data: { boardId, userId: owner.id, type: "card.moved", data: {} } });
    const now = new Date();
    const jobs = await enqueueDigests(prisma, now);

    const forEditor = captured.find((c) => c.body.payload.to === editor.email);
    expect(forEditor?.body).toMatchObject({
      type: "email.digest",
      idempotencyKey: `digest:${editor.id}:${now.toISOString().slice(0, 10)}`,
      payload: { userName: editor.email.split("@")[0], items: [{ title: expect.stringContaining("Jobs"), url: expect.stringContaining(boardId) }] },
    });
    // The owner did the only activity on this board, so gets no digest about it.
    expect(captured.find((c) => c.body.payload.to === owner.email)).toBeUndefined();
    expect(jobs.length).toBe(captured.length);
  });
});

describe("RelayQ round trip", () => {
  const SERVICE_TOKEN = "svc-token-for-tests";
  const WEBHOOK_SECRET = "whsec-for-tests";
  // Byte-for-byte RelayQ's sign(): hex HMAC-SHA256 of the raw JSON body.
  const sign = (raw: string, secret = WEBHOOK_SECRET) => createHmac("sha256", secret).update(raw).digest("hex");
  const callback = (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    const req = request(app).post(`/boards/${boardId}/export/callback`).set("content-type", "application/json");
    if (signature !== undefined) req.set("x-relayq-signature", signature);
    return req.send(raw);
  };
  const startExport = async () =>
    (await request(app).post(`/boards/${boardId}/export`).set("Authorization", owner.auth).send({ format: "json" })).body.jobId as string;

  beforeEach(() => {
    process.env.RELAYQ_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.RELAYQ_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it("RelayQ's service token reads any board; a wrong token is 401", async () => {
    const ok = await request(app).get(`/boards/${boardId}`).set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: boardId, title: "Jobs", columns: [{ title: "c", cards: [{ id: cardId, title: "card" }] }] });
    expect((await request(app).get(`/boards/${boardId}`).set("Authorization", "Bearer nope")).status).toBe(401);
    expect((await request(app).get("/boards/missing").set("Authorization", `Bearer ${SERVICE_TOKEN}`)).status).toBe(404);
  });

  it("service token is rejected when RELAYQ_SERVICE_TOKEN is unset", async () => {
    delete process.env.RELAYQ_SERVICE_TOKEN;
    expect((await request(app).get(`/boards/${boardId}`).set("Authorization", `Bearer ${SERVICE_TOKEN}`)).status).toBe(401);
  });

  it("export is queued, then a signed callback marks it ready; a repeat delivery is a no-op 204", async () => {
    const jobId = await startExport();
    const status = () => request(app).get(`/boards/${boardId}/exports/${jobId}`).set("Authorization", editor.auth);
    expect((await status()).body).toEqual({ jobId, format: "json", status: "queued", url: null });

    const body = { jobId, url: "https://bucket.s3.amazonaws.com/exports/x.json?sig=1" };
    expect((await callback(body, sign(JSON.stringify(body)))).status).toBe(204);
    expect((await status()).body).toEqual({ jobId, format: "json", status: "ready", url: body.url });

    expect((await callback(body, sign(JSON.stringify(body)))).status).toBe(204);
    expect((await status()).body.status).toBe("ready");
  });

  it("callback accepts an inline data: export larger than express's 100kb default", async () => {
    const jobId = await startExport();
    const body = { jobId, url: `data:application/json;base64,${Buffer.alloc(300_000, "a").toString("base64")}` };
    expect((await callback(body, sign(JSON.stringify(body)))).status).toBe(204);
    expect((await request(app).get(`/boards/${boardId}/exports/${jobId}`).set("Authorization", editor.auth)).body.url).toBe(body.url);
  });

  it("callback with a missing, wrong-secret or tampered signature → 401 and no change", async () => {
    const jobId = await startExport();
    const body = { jobId, url: "https://evil.example/x" };
    expect((await callback(body)).status).toBe(401);
    expect((await callback(body, sign(JSON.stringify(body), "other-secret"))).status).toBe(401);
    expect((await callback(body, sign(JSON.stringify({ ...body, url: "https://ok.example" })))).status).toBe(401);
    const exp = await prisma.export.findUnique({ where: { jobId } });
    expect(exp).toMatchObject({ status: "queued", url: null });
  });

  it("callback for an unknown job → 404", async () => {
    const body = { jobId: "job-does-not-exist", url: "https://x.example" };
    expect((await callback(body, sign(JSON.stringify(body)))).status).toBe(404);
  });

  it("export status is members-only", async () => {
    const jobId = await startExport();
    const stranger = await prisma.user.create({ data: { email: uniqueEmail(), passwordHash: "x" } });
    const res = await request(app).get(`/boards/${boardId}/exports/${jobId}`).set("Authorization", `Bearer ${signAccess({ userId: stranger.id })}`);
    expect(res.status).toBe(404);
  });
});
