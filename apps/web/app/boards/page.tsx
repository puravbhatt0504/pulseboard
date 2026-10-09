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
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">Your boards</h1>
      <form onSubmit={create} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New board title"
          required
          maxLength={200}
          className="flex-1 rounded border border-zinc-300 px-3 py-2"
        />
        <button className="rounded bg-zinc-900 px-4 py-2 text-white">Create board</button>
      </form>
      {boards === null ? (
        <p className="text-zinc-500">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="text-zinc-500">No boards yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 bg-white">
          {boards.map((b) => (
            <li key={b.id}>
              <Link href={`/boards/${b.id}`} className="flex justify-between px-4 py-3 hover:bg-zinc-50">
                <span>{b.title}</span>
                <span className="text-sm text-zinc-500">{b.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
