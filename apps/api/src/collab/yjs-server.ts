import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { Socket } from "socket.io";
import type { Deps } from "../app.js";
import { invalidateBoard, requireRole } from "../boards/service.js";
import { cardBoard } from "../cards/service.js";
import type { ClientToServer, IO, ServerToClient, SocketData } from "../realtime/events.js";
import { loadState, saveState } from "./persistence.js";
import { traced } from "../tracing.js";

export const PERSIST_DEBOUNCE_MS = 2000;
/** Redis keeps every update of an active card this long after its last edit; Postgres has them long before. */
export const UPDATE_LOG_TTL_S = 600;
export const cardRoom = (cardId: string) => `card:${cardId}`;
const logKey = (cardId: string) => `collab:log:${cardId}`;
const channel = (cardId: string) => `collab:${cardId}`;

type Loaded = { doc: Y.Doc; boardId: string; timer?: NodeJS.Timeout; sockets: Set<string> };
type S = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
const bytes = (u: unknown): u is Uint8Array => u instanceof Uint8Array; // Buffer is a Uint8Array
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/**
 * Card descriptions as Yjs docs over the board's Socket.io connection.
 * Sync: client sends doc:join {cardId, sv: its state vector}; the ack carries {update: what it lacks, sv: ours},
 * and the client answers with doc:update of what we lack (its offline edits). Then each doc:update is applied,
 * relayed to the card's room (every instance's clients, via the socket.io redis adapter), appended to a Redis
 * list and published on a Redis channel so other instances' in-memory copies stay current. An instance opening a
 * doc applies Postgres state + that list, so it also has edits other instances haven't persisted yet. Applying a
 * Yjs update twice is a no-op, which is why the list needs no precise trimming, only a TTL.
 * Viewers can join and read; their updates are dropped. Awareness (carets) is relayed, not stored. Persistence: debounced merge-write to CardDoc, and
 * immediately when an instance's last socket on the card leaves (then the doc is unloaded there).
 */
export function attachCollab(io: IO, deps: Omit<Deps, "io">) {
  const { redis } = deps;
  const instance = randomUUID();
  const docs = new Map<string, Promise<Loaded | null>>();
  const sub = redis.duplicate();
  sub.on("error", (err) => console.error("redis (collab sub):", err.message));
  sub.on("message", (ch: string, msg: string) => {
    const { from, update } = JSON.parse(msg) as { from: string; update: string };
    if (from === instance) return;
    const cardId = ch.slice("collab:".length);
    void docs.get(cardId)?.then((d) => d && (Y.applyUpdate(d.doc, Buffer.from(update, "base64")), schedule(cardId, d)));
  });

  const persist = async (cardId: string, d: Loaded) => {
    clearTimeout(d.timer);
    d.timer = undefined;
    await saveState(deps, cardId, d.doc);
    await invalidateBoard(deps, d.boardId);
  };
  const schedule = (cardId: string, d: Loaded) => {
    d.timer ??= setTimeout(() => void persist(cardId, d).catch((e) => console.error("collab persist:", e.message)), PERSIST_DEBOUNCE_MS);
  };

  function open(cardId: string, boardId: string): Promise<Loaded | null> {
    let p = docs.get(cardId);
    if (!p) {
      p = (async () => {
        await sub.subscribe(channel(cardId)); // before reading the log, so nothing falls between the two
        const state = await loadState(deps, cardId);
        if (!state) return null;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state);
        for (const u of await redis.lrange(logKey(cardId), 0, -1)) Y.applyUpdate(doc, Buffer.from(u, "base64"));
        return { doc, boardId, sockets: new Set<string>() };
      })();
      docs.set(cardId, p);
      p.then((d) => d ?? unload(cardId), () => unload(cardId));
    }
    return p;
  }

  function unload(cardId: string) {
    docs.delete(cardId);
    void sub.unsubscribe(channel(cardId)).catch(() => {});
  }

  async function leave(socket: S, cardId: string) {
    socket.data.cards?.delete(cardId);
    void socket.leave(cardRoom(cardId));
    const d = await docs.get(cardId);
    if (!d) return;
    d.sockets.delete(socket.id);
    if (d.sockets.size === 0) {
      unload(cardId);
      await persist(cardId, d);
    }
  }

  io.on("connection", (socket: S) => {
    socket.data.cards = new Map();

    socket.on("doc:join", traced("doc:join", async (p, ack) => {
      if (typeof ack !== "function") return;
      try {
        const cardId = typeof p?.cardId === "string" ? p.cardId : "";
        const { userId } = socket.data;
        const boardId = cardId ? await cardBoard(deps, userId, cardId, false).catch(() => null) : null;
        const role = boardId ? await requireRole(deps, boardId, userId, false) : null;
        const d = boardId && role ? await open(cardId, boardId) : null;
        if (!d || !role) return ack({ error: "forbidden" });
        d.sockets.add(socket.id);
        socket.data.cards!.set(cardId, role);
        void socket.join(cardRoom(cardId));
        const sv = bytes(p.sv) ? p.sv : undefined;
        ack({ update: Y.encodeStateAsUpdate(d.doc, sv), sv: Y.encodeStateVector(d.doc), readOnly: role === "viewer" });
      } catch (e) {
        console.error("doc:join:", (e as Error).message);
        ack({ error: "bad_request" });
      }
    }));

    socket.on("doc:update", traced("doc:update", async (p) => {
      const cardId = typeof p?.cardId === "string" ? p.cardId : "";
      const role = socket.data.cards?.get(cardId);
      if (!role || role === "viewer" || !bytes(p.update)) return void socket.emit("error", { code: role ? "forbidden" : "bad_request" });
      const d = await docs.get(cardId);
      if (!d) return;
      try {
        Y.applyUpdate(d.doc, p.update);
      } catch {
        return void socket.emit("error", { code: "bad_request" });
      }
      socket.to(cardRoom(cardId)).emit("doc:update", { cardId, update: p.update });
      const enc = b64(p.update);
      // ponytail: the log grows for as long as a card is edited without a 10-minute pause; LTRIM after persist if that bites.
      await redis.multi().rpush(logKey(cardId), enc).expire(logKey(cardId), UPDATE_LOG_TTL_S).exec();
      await redis.publish(channel(cardId), JSON.stringify({ from: instance, update: enc }));
      schedule(cardId, d);
    }));

    // Carets and names: relayed as-is to the card's room, never stored. Viewers have carets too.
    socket.on("doc:awareness", (p) => {
      const cardId = typeof p?.cardId === "string" ? p.cardId : "";
      if (socket.data.cards?.has(cardId) && bytes(p.update) && p.update.length <= 4096) {
        socket.to(cardRoom(cardId)).emit("doc:awareness", { cardId, update: p.update });
      }
    });

    socket.on("doc:leave", traced("doc:leave", async (p) => {
      if (typeof p?.cardId === "string" && socket.data.cards?.has(p.cardId)) await leave(socket, p.cardId).catch(console.error);
    }));

    socket.on("disconnect", () => {
      for (const cardId of [...(socket.data.cards?.keys() ?? [])]) void leave(socket, cardId).catch(console.error);
    });
  });

  return {
    /** Persist every loaded doc now (shutdown, tests). */
    flush: async () => {
      for (const [cardId, p] of docs) {
        const d = await p;
        if (d) await persist(cardId, d);
      }
    },
  };
}
