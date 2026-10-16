"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

type BoardSummary = { id: string; title: string; role: string };

export default function BoardsPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    api<BoardSummary[]>("/boards")
      .then(setBoards)
      .catch((e) => e instanceof ApiError && e.status === 401 && router.replace("/login"));
  }, [router]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const board = await api<BoardSummary>("/boards", { method: "POST", body: { title } });
    router.push(`/boards/${board.id}`);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-1 text-sm font-semibold tracking-wide text-violet-700">PulseBoard</p>
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">Your boards</h1>
      <form onSubmit={create} className="mb-8 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New board title"
          required
          maxLength={200}
          className="h-10 flex-1 rounded-lg border border-zinc-300 bg-white px-3 shadow-xs outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
        />
        <button className="h-10 rounded-lg bg-zinc-900 px-4 font-medium text-white hover:bg-zinc-700">Create board</button>
      </form>
      {boards === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
          No boards yet. Create one above, then invite teammates from inside it.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {boards.map((b) => (
            <li key={b.id}>
              <Link
                href={`/boards/${b.id}`}
                className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-4 shadow-xs transition hover:border-zinc-300 hover:shadow-sm"
              >
                <span className="font-medium">{b.title}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{b.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
