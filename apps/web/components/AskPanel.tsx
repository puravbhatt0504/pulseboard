"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

type Props = { boardId: string; titles: Map<string, string>; onOpen: (cardId: string) => void; onClose: () => void };

/** "Ask the board": POST /boards/:id/ask streams SSE `token` events, then `done` {citations} or `error`. */
export function AskPanel({ boardId, titles, onOpen, onClose }: Props) {
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "asking" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = String(new FormData(e.currentTarget).get("question") ?? "").trim();
    if (!question || state === "asking") return;
    setAnswer("");
    setCitations([]);
    setState("asking");
    const fail = (msg: string) => (setError(msg), setState("error"));
    try {
      const res = await apiFetch(`/boards/${boardId}/ask`, { method: "POST", body: { question } });
      if (!res.ok || !res.body) return fail((await res.json().catch(() => ({}))).error ?? "Could not ask");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const frames = buf.split("\n\n");
        buf = frames.pop()!;
        for (const frame of frames) {
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null");
          if (event === "token") setAnswer((a) => a + data.text);
          if (event === "done") setCitations(data.citations);
          if (event === "error") return fail(data.error);
        }
      }
      setState("idle");
    } catch {
      fail("Network error");
    }
  }

  return (
    <aside data-testid="ask-panel" className="fixed right-0 top-0 z-40 flex h-full w-96 flex-col gap-3 border-l border-zinc-200 bg-white p-4 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Ask the board</h2>
        <button onClick={onClose} aria-label="Close ask panel" className="text-zinc-500 hover:text-zinc-900">
          ✕
        </button>
      </div>
      <form onSubmit={submit} className="flex gap-2 text-sm">
        <input name="question" required maxLength={500} placeholder="What's blocking launch?" aria-label="Question" className="flex-1 rounded border border-zinc-300 px-2 py-1" />
        <button disabled={state === "asking"} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50">
          Ask
        </button>
      </form>
      {state === "asking" && !answer && <p className="text-sm text-zinc-500">Thinking…</p>}
      {answer && (
        <p data-testid="ask-answer" className="whitespace-pre-wrap text-sm">
          {answer.replace(/\s?\[card:[A-Za-z0-9_-]+\]/g, "")}
        </p>
      )}
      {citations.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Sources">
          {citations.map((id) => (
            <li key={id}>
              <button data-testid="citation" onClick={() => onOpen(id)} className="max-w-full truncate rounded-full bg-zinc-100 px-3 py-1 text-xs hover:bg-zinc-200">
                {titles.get(id) ?? "Card"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state === "error" && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </aside>
  );
}
