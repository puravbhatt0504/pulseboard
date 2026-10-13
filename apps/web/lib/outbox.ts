import { api, ApiError } from "./api";

/**
 * Board REST writes made offline, queued in IndexedDB and replayed in order on reconnect.
 * `tmpId`: the id an offline create shows in the UI until replay learns the real one; later queued writes that
 * mention it (a card added to an offline column, a move of an offline card) are rewritten to the real id.
 */
export type Op = { path: string; method: string; body?: unknown; tmpId?: string };
type Stored = Op & { seq: number };

const STORE = "ops";
export const tmpId = () => `tmp-${crypto.randomUUID()}`;
export const isTmp = (id: string) => id.startsWith("tmp-");

function open(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open("pulseboard:outbox", 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

/** One transaction; `fn` may issue several requests, resolves with the last one's result when it commits. */
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((ok, fail) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => ok(req?.result as T);
      t.onerror = () => fail(t.error);
    });
  } finally {
    db.close();
  }
}

/**
 * api() for board writes. Returns the response, or null if the write was queued: we're offline, the request got no
 * answer, or earlier writes are still queued (sending this one first would break their order). An ApiError (the
 * server answered no) is thrown as usual.
 * ponytail: a POST whose response was lost in transit is queued and replayed, so it can create twice.
 */
export async function write<T>(op: Op): Promise<T | null> {
  if (navigator.onLine && (await tx("readonly", (s) => s.count())) === 0) {
    try {
      return await api<T>(op.path, op);
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
  }
  await tx("readwrite", (s) => void s.add(op));
  return null;
}

/**
 * Send queued writes oldest first. One the server rejects (4xx other than 401) is dropped and passed to onDrop,
 * never retried. A network error, 401 or 5xx stops the replay; the rest wait for the next one.
 * The Web Lock keeps two tabs from sending the same queue. Returns how many writes left the queue.
 */
export async function replay(onDrop: (op: Op, err: ApiError) => void): Promise<number> {
  return navigator.locks.request("pulseboard:outbox", async (): Promise<number> => {
    let done = 0;
    for (;;) {
      const [next] = await tx<Stored[]>("readonly", (s) => s.getAll(null, 1));
      if (!next) return done;
      const { seq, ...op } = next;
      try {
        const res = await api<{ id: string } | undefined>(op.path, op);
        if (op.tmpId && res) await rewrite(op.tmpId, res.id);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status === 401 || e.status >= 500) return done;
        onDrop(op, e);
      }
      await tx("readwrite", (s) => void s.delete(seq));
      done++;
    }
  });
}

/** Swap a tmp id for the real one in every queued write. */
function rewrite(tmp: string, real: string) {
  return tx("readwrite", (s) => {
    s.openCursor().onsuccess = (e) => {
      const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!c) return;
      c.update(JSON.parse(JSON.stringify(c.value).replaceAll(tmp, real)));
      c.continue();
    };
  });
}
