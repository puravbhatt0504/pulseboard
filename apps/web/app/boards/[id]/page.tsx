"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { api, ApiError, getToken, refresh, SOCKET_URL } from "@/lib/api";
import { AskPanel } from "@/components/AskPanel";
import { CardDescription } from "@/components/CardDescription";
import { TriagePanel } from "@/components/TriagePanel";
import { LabelChip, PriorityChip } from "@/components/Chips";
import { isTmp, replay, tmpId, write } from "@/lib/outbox";

type Card = { id: string; columnId: string; title: string; position: string; labels?: string[]; priority?: string | null };
type Column = { id: string; title: string; cards: Card[] };
type Board = { id: string; title: string; columns: Column[] };
type User = { id: string; name: string; color: string };
type Hit = { cardId: string; title: string };

const CURSOR_INTERVAL_MS = 50; // ≤ 20/s, matches the server throttle
const control = "h-8 rounded-md border border-zinc-300 bg-white px-2.5 text-sm shadow-xs outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200";

// Server-confirmed card: drop it from wherever it was, re-insert by (position, id).
function upsertCard(board: Board, card: Card): Board {
  return {
    ...board,
    columns: board.columns.map((col) => {
      const cards = col.cards.filter((c) => c.id !== card.id);
      if (col.id === card.columnId) {
        cards.push(card);
        cards.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
      }
      return { ...col, cards };
    }),
  };
}

// Optimistic placement before the server assigns a position: splice by index.
function placeCard(board: Board, cardId: string, columnId: string, beforeCardId: string | null): Board {
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
  if (!card) return board;
  return {
    ...board,
    columns: board.columns.map((col) => {
      const cards = col.cards.filter((c) => c.id !== cardId);
      if (col.id === columnId) {
        const i = beforeCardId ? cards.findIndex((c) => c.id === beforeCardId) : -1;
        cards.splice(i === -1 ? cards.length : i, 0, { ...card, columnId });
      }
      return { ...col, cards };
    }),
  };
}

// Prefer the card under the pointer over the column that contains it.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const onCard = hits.filter((h) => String(h.id).startsWith("card:"));
  return onCard.length ? onCard : hits;
};

export default function BoardPage() {
  const { id: boardId } = useParams<{ id: string }>();
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [users, setUsers] = useState<User[]>([]);
  const [cursors, setCursors] = useState<Record<string, { x: number; y: number }>>({});
  const [error, setError] = useState("");
  // Board export via RelayQ: the job we started, then its download url from the export:ready socket event.
  const [exportJob, setExportJob] = useState<{ jobId: string; url?: string } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [me, setMe] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const lastCursor = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    let socket: Socket | undefined;
    let cancelled = false;
    api<Board>(`/boards/${boardId}`)
      .then((b) => {
        if (cancelled) return;
        setBoard(b);
        setStatus("ready");
        // Connect only once the token exists (the board fetch may have just refreshed it).
        socket = io(SOCKET_URL, { auth: (cb) => cb({ token: getToken() }), transports: ["websocket"] });
        socketRef.current = socket;
        setSocket(socket);
        // Every (re)connect: send writes queued offline, then refetch if anything changed or events were missed.
        let reconnect = false;
        socket.on("connect", async () => {
          socket!.emit("join_board", { boardId });
          const sent = await replay((op, e) => setError(`A change made offline was dropped (${e.status} ${e.message}): ${op.method} ${op.path}`));
          if (sent || reconnect) setBoard(await api<Board>(`/boards/${boardId}`));
          reconnect = true;
        });
        socket.on("connect_error", async (err) => {
          if (err.message === "unauthorized" && (await refresh())) socket!.connect();
        });
        for (const evt of ["card:created", "card:updated", "card:moved"] as const) {
          socket.on(evt, ({ card }: { card: Card }) => setBoard((prev) => prev && upsertCard(prev, card)));
        }
        // Every member hears export:ready; only the job this tab started is shown.
        socket.on("export:ready", ({ jobId, url }: { jobId: string; url: string }) =>
          setExportJob((job) => (job?.jobId === jobId ? { jobId, url } : job)),
        );
        socket.on("presence:update", ({ users }: { users: User[] }) => {
          setUsers(users);
          const present = new Set(users.map((u) => u.id));
          setCursors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => present.has(id))));
        });
        // Batches include our own cursor; the access token's `sub` is our user id.
        const me = JSON.parse(atob(getToken()!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
        setMe(me);
        socket.on("cursors", ({ cursors: batch }: { cursors: { userId: string; x: number; y: number }[] }) =>
          setCursors((prev) => {
            const next = { ...prev };
            for (const c of batch) if (c.userId !== me) next[c.userId] = { x: c.x, y: c.y };
            return next;
          }),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setStatus("missing");
      });
    // Going offline drops the socket at once (instead of waiting for ping timeouts), so edits are clearly local
    // until it reconnects and the card doc resyncs.
    const offline = () => socket?.disconnect();
    const online = () => socket?.connect();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      cancelled = true;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      socket?.close();
    };
  }, [boardId, router]);

  // Board search (semantic + full-text on the server), debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) return void setHits(null);
    const t = setTimeout(() => {
      api<Hit[]>(`/boards/${boardId}/search?q=${encodeURIComponent(q)}`).then(setHits, () => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, boardId]);

  // Duplicate hint while typing a new card title; [] on any failure (it's only a hint).
  const findSimilar = (title: string) =>
    api<Hit[]>(`/boards/${boardId}/cards/similar`, { method: "POST", body: { title } }).catch(() => [] as Hit[]);

  function onPointerMove(e: React.PointerEvent) {
    const now = Date.now();
    if (!areaRef.current || now - lastCursor.current < CURSOR_INTERVAL_MS) return;
    lastCursor.current = now;
    const rect = areaRef.current.getBoundingClientRect();
    socketRef.current?.emit("cursor", { x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) });
  }

  async function onDragEnd({ active, over }: DragEndEvent) {
    if (!board || !over) return;
    const cardId = String(active.id);
    const [kind, targetId] = String(over.id).split(":");
    let columnId: string;
    let beforeCardId: string | null = null;
    if (kind === "card") {
      if (targetId === cardId) return;
      columnId = board.columns.find((c) => c.cards.some((k) => k.id === targetId))!.id;
      beforeCardId = targetId;
    } else {
      columnId = targetId;
    }
    const snapshot = board;
    setBoard(placeCard(board, cardId, columnId, beforeCardId));
    try {
      // API: `after` = the card that ends up directly below the moved one; omitted = append.
      const card = await write<Card>({
        path: `/cards/${cardId}`,
        method: "PATCH",
        body: beforeCardId ? { columnId, after: beforeCardId } : { columnId },
      });
      if (card) setBoard((prev) => prev && upsertCard(prev, card)); // null: queued, the optimistic placement stays
    } catch (e) {
      setBoard(snapshot);
      setError(`Move failed: ${(e as Error).message}`);
    }
  }

  async function addColumn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const title = new FormData(form).get("title");
    try {
      const id = tmpId();
      const col = (await write<Column>({ path: `/boards/${boardId}/columns`, method: "POST", body: { title }, tmpId: id })) ?? { id, title: String(title), cards: [] };
      setBoard((prev) => prev && { ...prev, columns: [...prev.columns, { ...col, cards: [] }] });
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addCard(e: React.FormEvent<HTMLFormElement>, columnId: string) {
    e.preventDefault();
    const form = e.currentTarget;
    const title = new FormData(form).get("title");
    try {
      const id = tmpId();
      // Offline: shown last in the column ("~" sorts after any real position) until replay + refetch.
      const card = (await write<Card>({ path: `/columns/${columnId}/cards`, method: "POST", body: { title }, tmpId: id })) ?? { id, columnId, title: String(title), position: "~" };
      setBoard((prev) => prev && upsertCard(prev, card));
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function startExport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const format = new FormData(e.currentTarget).get("format");
    try {
      const { jobId } = await api<{ jobId: string }>(`/boards/${boardId}/export`, { method: "POST", body: { format } });
      setExportJob({ jobId });
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`);
    }
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    try {
      await api(`/boards/${boardId}/members`, { method: "POST", body: { email: data.get("email"), role: data.get("role") } });
      form.reset();
      setError("");
    } catch (err) {
      setError(`Invite failed: ${(err as Error).message}`);
    }
  }

  const openCard = board?.columns.flatMap((c) => c.cards).find((c) => c.id === openCardId);
  const meUser = users.find((u) => u.id === me) ?? { name: "you", color: "#71717a" };

  if (status === "loading") return <p className="p-8 text-sm text-zinc-500">Loading board…</p>;
  if (status === "missing" || !board)
    return (
      <p className="p-8 text-sm">
        Board not found. <Link href="/boards" className="underline">Back to your boards</Link>
      </p>
    );

  return (
    <main className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 bg-white/90 px-6 py-3 backdrop-blur">
        <Link href="/boards" className="text-sm text-zinc-500 hover:text-zinc-900" aria-label="All boards">
          ← Boards
        </Link>
        <h1 className="text-lg font-semibold tracking-tight">{board.title}</h1>
        <div className="flex -space-x-2" aria-label="Online now">
          {users.map((u) => (
            <span
              key={u.id}
              data-testid="presence-avatar"
              title={u.name}
              style={{ background: u.color }}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white"
            >
              {u.name.slice(0, 2).toUpperCase()}
            </span>
          ))}
        </div>
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards"
            aria-label="Search cards"
            className={`${control} w-60`}
          />
          {hits && (
            <ul data-testid="search-results" className="absolute z-30 mt-1 w-80 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg">
              {hits.length === 0 && <li className="px-3 py-1.5 text-zinc-500">No matches</li>}
              {hits.map((h) => (
                <li key={h.cardId}>
                  <button
                    onClick={() => (setOpenCardId(h.cardId), setQuery(""))}
                    className="w-full truncate px-3 py-1.5 text-left hover:bg-zinc-100"
                  >
                    {h.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={() => setAsking((a) => !a)}
          aria-pressed={asking}
          className="h-8 rounded-md border border-violet-300 bg-violet-50 px-3 text-sm font-medium text-violet-800 hover:bg-violet-100"
        >
          ✦ Ask the board
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <form onSubmit={startExport} className="flex items-center gap-1.5">
            <select name="format" aria-label="Export format" className={control} defaultValue="csv">
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
            <button disabled={!!exportJob && !exportJob.url} className={`${control} hover:bg-zinc-50 disabled:opacity-50`}>
              Export
            </button>
            {exportJob &&
              (exportJob.url ? (
                <a href={exportJob.url} download={`board-${boardId}`} className="text-sm text-blue-700 underline" data-testid="export-link">
                  Download export
                </a>
              ) : (
                <span className="text-sm text-zinc-500">Exporting…</span>
              ))}
          </form>
          <span className="hidden h-6 w-px bg-zinc-200 md:block" aria-hidden />
          <form onSubmit={invite} className="flex items-center gap-1.5">
            <input name="email" type="email" required placeholder="Invite by email" className={`${control} w-48`} />
            <select name="role" className={control} defaultValue="editor">
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button className="h-8 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700">Invite</button>
          </form>
        </div>
      </header>
      {error && (
        <p role="alert" className="bg-red-50 px-6 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div ref={areaRef} onPointerMove={onPointerMove} className="relative flex-1 overflow-x-auto p-6">
        <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
          <div className="flex items-start gap-4">
            {board.columns.length === 0 && (
              <p className="w-64 shrink-0 rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                Empty board. Add a column (e.g. To do, In progress, Done) to start.
              </p>
            )}
            {board.columns.map((col) => (
              <ColumnView key={col.id} column={col} onAddCard={addCard} onOpen={(id) => !isTmp(id) && setOpenCardId(id)} findSimilar={findSimilar} />
            ))}
            <form onSubmit={addColumn} className="w-64 shrink-0">
              <input name="title" required maxLength={200} placeholder="+ Add column" className="w-full rounded-xl border border-dashed border-zinc-300 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-zinc-500 hover:border-zinc-400 focus:border-zinc-500 focus:bg-white" />
            </form>
          </div>
        </DndContext>
        {asking && (
          <AskPanel
            boardId={boardId}
            titles={new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c.title]))}
            onOpen={setOpenCardId}
            onClose={() => setAsking(false)}
          />
        )}
        {openCard && socket && (
          <aside role="dialog" aria-label="Card" className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <h2 className="text-lg leading-snug font-semibold tracking-tight">{openCard.title}</h2>
              <button onClick={() => setOpenCardId(null)} aria-label="Close card" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900">
                ✕
              </button>
            </div>
            <TriagePanel key={`t-${openCard.id}`} socket={socket} cardId={openCard.id} />
            <CardDescription key={openCard.id} socket={socket} cardId={openCard.id} user={meUser} />
          </aside>
        )}
        {Object.entries(cursors).map(([userId, pos]) => {
          const user = users.find((u) => u.id === userId);
          return (
            <div
              key={userId}
              data-testid={`cursor-${userId}`}
              className="pointer-events-none absolute z-50 transition-transform duration-75"
              style={{ left: 0, top: 0, transform: `translate(${pos.x}px, ${pos.y}px)` }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path d="M0 0 L0 14 L4 10 L8 16 L10 15 L6 9 L12 9 Z" fill={user?.color ?? "#000"} />
              </svg>
              <span className="ml-3 rounded px-1 text-xs text-white" style={{ background: user?.color ?? "#000" }}>
                {user?.name}
              </span>
            </div>
          );
        })}
      </div>
    </main>
  );
}

function ColumnView({
  column,
  onAddCard,
  onOpen,
  findSimilar,
}: {
  column: Column;
  onAddCard: (e: React.FormEvent<HTMLFormElement>, columnId: string) => void;
  onOpen: (cardId: string) => void;
  findSimilar: (title: string) => Promise<Hit[]>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
  const [draft, setDraft] = useState("");
  const [similar, setSimilar] = useState<Hit[]>([]);
  useEffect(() => {
    if (draft.trim().length < 8) return void setSimilar([]);
    const t = setTimeout(() => void findSimilar(draft.trim()).then(setSimilar), 400);
    return () => clearTimeout(t);
  }, [draft]); // not findSimilar: a new function each render would re-query on every keystroke anyway
  return (
    <section
      ref={setNodeRef}
      data-testid="column"
      data-column-id={column.id}
      className={`w-72 shrink-0 rounded-xl p-3 transition-colors ${isOver ? "bg-zinc-200/80 ring-2 ring-zinc-300" : "bg-zinc-100/80"}`}
    >
      <div className="mb-3 flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold text-zinc-800">{column.title}</h2>
        <span className="rounded-full bg-zinc-200 px-1.5 text-[11px] font-medium text-zinc-600" aria-label={`${column.cards.length} cards`}>
          {column.cards.length}
        </span>
      </div>
      <ul className="min-h-8 space-y-2">
        {column.cards.map((card) => (
          <CardView key={card.id} card={card} onOpen={onOpen} />
        ))}
      </ul>
      <form onSubmit={(e) => (onAddCard(e, column.id), setDraft(""))} className="mt-3">
        <input
          name="title"
          required
          maxLength={200}
          placeholder="+ Add card"
          onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-500 hover:bg-white/70 focus:border-zinc-300 focus:bg-white"
        />
        {similar.length > 0 && (
          <p data-testid="similar-hint" className="mt-1 text-xs text-amber-700">
            Looks like{" "}
            <button type="button" onClick={() => onOpen(similar[0].cardId)} className="underline">
              {similar[0].title}
            </button>
          </p>
        )}
      </form>
    </section>
  );
}

function CardView({ card, onOpen }: { card: Card; onOpen: (cardId: string) => void }) {
  const drag = useDraggable({ id: card.id });
  const drop = useDroppable({ id: `card:${card.id}` });
  const style = drag.transform ? { transform: `translate(${drag.transform.x}px, ${drag.transform.y}px)` } : undefined;
  return (
    <li
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      {...drag.attributes}
      style={style}
      onClick={() => onOpen(card.id)} // a drag needs 5 px of movement, so a click never starts one
      data-testid="card"
      className={`cursor-grab rounded-lg border bg-white px-3 py-2.5 text-sm shadow-xs transition hover:border-zinc-300 hover:shadow-sm ${
        drag.isDragging ? "relative z-10 rotate-1 opacity-90 shadow-lg" : ""
      } ${drop.isOver && !drag.isDragging ? "border-t-4 border-t-zinc-900" : "border-zinc-200"}`}
    >
      <p className="leading-snug text-zinc-900">{card.title}</p>
      {(card.labels?.length || card.priority) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.priority && <PriorityChip priority={card.priority} />}
          {card.labels?.map((l) => <LabelChip key={l} label={l} />)}
        </div>
      )}
    </li>
  );
}
