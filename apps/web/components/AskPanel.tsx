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
    <aside data-testid="ask-panel" className="fixed right-0 top-0 z-40 flex h-full w-96 max-w-full flex-col gap-4 border-l border-zinc-200 bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold tracking-tight text-violet-800">✦ Ask the board</h2>
          <p className="text-xs text-zinc-500">Answers come only from this board, with the cards they used.</p>
        </div>
        <button onClick={onClose} aria-label="Close ask panel" className="self-start rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900">
          ✕
        </button>
      </div>
      <form onSubmit={submit} className="flex gap-2 text-sm">
        <input name="question" required maxLength={500} placeholder="What's blocking launch?" aria-label="Question" className="h-9 flex-1 rounded-lg border border-zinc-300 px-3 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
        <button disabled={state === "asking"} className="h-9 rounded-lg bg-violet-700 px-4 font-medium text-white hover:bg-violet-600 disabled:opacity-50">
          Ask
        </button>
      </form>
      {state === "asking" && !answer && <p className="text-sm text-zinc-500">Thinking…</p>}
      {answer && (
        <p data-testid="ask-answer" className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm leading-relaxed">
          {answer.replace(/\s?\[card:[A-Za-z0-9_-]+\]/g, "")}
        </p>
      )}
      {citations.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label="Sources">
          <li className="text-xs font-medium text-zinc-500">Sources</li>
          {citations.map((id) => (
            <li key={id}>
              <button data-testid="citation" onClick={() => onOpen(id)} className="max-w-full truncate rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs text-violet-800 hover:bg-violet-100">
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
