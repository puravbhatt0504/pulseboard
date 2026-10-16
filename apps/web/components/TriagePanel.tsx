"use client";

import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { api } from "@/lib/api";
import { LabelChip, PriorityChip } from "@/components/Chips";

type Field = "labels" | "priority" | "assignee";
type Member = { id: string; email: string };
type Triage = {
  card: { labels: string[]; priority: string | null; assignee: Member | null };
  suggestion: { labels: string[]; priority: string | null; assignee: Member | null; reason: string } | null;
  decided: Partial<Record<Field, boolean>>;
};

const name = (m: Member) => m.email.split("@")[0];
type Eta = { p50Hours: number; p90Hours: number } | { done: true };
/** 0.4 → "~1 hour", 5 → "~5 hours", 30 → "~1 day", 50 → "~2 days". */
const plural = (n: number, unit: string) => `~${n} ${unit}${n === 1 ? "" : "s"}`;
export const humanHours = (h: number) => (h < 24 ? plural(Math.max(1, Math.round(h)), "hour") : plural(Math.round(h / 24), "day"));

/** Card labels / priority / assignee, plus AI triage suggestions as one-click chips. Nothing applies until clicked. */
export function TriagePanel({ cardId, socket }: { cardId: string; socket: Socket }) {
  const [t, setT] = useState<Triage | null>(null);
  const [eta, setEta] = useState<Eta | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<Triage>(`/cards/${cardId}/triage`).then(setT, () => {});
    void api<Eta>(`/cards/${cardId}/eta`).then(setEta, () => setEta(null)); // 503 = no model: show nothing
  }, [cardId]);

  useEffect(() => {
    load();
    const onTriage = (p: { cardId: string }) => p.cardId === cardId && load();
    const onUpdated = (p: { card: { id: string } }) => p.card.id === cardId && load();
    socket.on("card:triage", onTriage);
    socket.on("card:updated", onUpdated);
    return () => {
      socket.off("card:triage", onTriage);
      socket.off("card:updated", onUpdated);
    };
  }, [cardId, socket, load]);

  async function decide(field: Field, accepted: boolean) {
    setError("");
    try {
      setT(await api<Triage>(`/cards/${cardId}/triage/feedback`, { method: "POST", body: { field, accepted } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!t) return null;
  const s = t.suggestion;
  const pending = (
    [
      ["labels", s?.labels.length ? s.labels.join(", ") : null],
      ["priority", s?.priority ?? null],
      ["assignee", s?.assignee ? name(s.assignee) : null],
    ] as [Field, string | null][]
  ).filter(([field, value]) => value && t.decided[field] === undefined);

  return (
    <section className="mb-4 space-y-2 text-sm" aria-label="Triage">
      <dl className="grid grid-cols-[6rem_1fr] items-center gap-y-1.5">
        <dt className="text-zinc-500">Labels</dt>
        <dd data-testid="card-labels" className="flex flex-wrap gap-1">{t.card.labels.length ? t.card.labels.map((l) => <LabelChip key={l} label={l} />) : "—"}</dd>
        <dt className="text-zinc-500">Priority</dt>
        <dd data-testid="card-priority">{t.card.priority ? <PriorityChip priority={t.card.priority} /> : "—"}</dd>
        <dt className="text-zinc-500">Assignee</dt>
        <dd data-testid="card-assignee">{t.card.assignee ? name(t.card.assignee) : "—"}</dd>
        {eta && "p50Hours" in eta && (
          <>
            <dt className="text-zinc-500">Done in</dt>
            <dd data-testid="card-eta" title={`90% of similar cards finish within ${humanHours(eta.p90Hours)}`}>
              usually {humanHours(eta.p50Hours)}
            </dd>
          </>
        )}
      </dl>
      {s && pending.length > 0 && (
        <div data-testid="triage-suggestion" className="rounded-md border border-violet-200 bg-violet-50 p-3">
          <p className="mb-2 text-xs text-violet-800"><span className="font-semibold">✦ Suggested by AI</span>{s.reason && ` · ${s.reason}`}</p>
          <ul className="flex flex-wrap gap-2">
            {pending.map(([field, value]) => (
              <li key={field} className="flex items-center overflow-hidden rounded-full border border-violet-300 bg-white">
                <button
                  data-testid={`triage-accept-${field}`}
                  onClick={() => decide(field, true)}
                  className="px-3 py-1 hover:bg-violet-100"
                  aria-label={`Apply ${field}: ${value}`}
                >
                  {field}: {value}
                </button>
                <button
                  data-testid={`triage-reject-${field}`}
                  onClick={() => decide(field, false)}
                  className="border-l border-violet-200 px-2 py-1 text-zinc-500 hover:bg-violet-100"
                  aria-label={`Dismiss suggested ${field}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </section>
  );
}
