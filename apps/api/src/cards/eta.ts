import type { Deps } from "../app.js";
import { requireRole } from "../boards/service.js";
import { HttpError } from "../http.js";

// Completion-time model (ml/eta): POST ${ETA_URL}/predict {features} → {p50Hours, p90Hours}. Off when ETA_URL is unset.
type EtaColumn = "backlog" | "todo" | "doing" | "review";
const DONE = /\bdone\b/i;
// ponytail: a board with no finished cards yet gets this prior for its median; replace with a global median if it misleads.
const PRIOR_MEDIAN_HOURS = 48;

/** Column title → the model's column. "Done" columns get no prediction (null). Unknown titles count as "todo". */
export function etaColumn(title: string): EtaColumn | null {
  if (DONE.test(title)) return null;
  if (/backlog|icebox/i.test(title)) return "backlog";
  if (/doing|progress|wip/i.test(title)) return "doing";
  if (/review|qa|testing/i.test(title)) return "review";
  return "todo";
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Hours from creation to the move into a Done column, for every finished card on the board. */
async function finishedHours({ prisma }: Pick<Deps, "prisma">, boardId: string) {
  const done = await prisma.column.findMany({ where: { boardId }, select: { id: true, title: true } });
  const doneIds = new Set(done.filter((c) => DONE.test(c.title)).map((c) => c.id));
  const cards = await prisma.card.findMany({ where: { columnId: { in: [...doneIds] } }, select: { id: true, createdAt: true, assigneeId: true } });
  const moves = await prisma.activity.findMany({
    where: { boardId, type: "card.moved" },
    orderBy: { createdAt: "desc" },
    select: { data: true, createdAt: true },
  });
  return cards.flatMap((c) => {
    const m = moves.find((a) => (a.data as { cardId?: string }).cardId === c.id && doneIds.has((a.data as { columnId?: string }).columnId ?? ""));
    return m ? [{ assigneeId: c.assigneeId, hours: (m.createdAt.getTime() - c.createdAt.getTime()) / 36e5 }] : [];
  });
}

/** The model's features for one card (all required by the server; see ml/eta/eta/features.py). */
export async function etaFeatures(deps: Pick<Deps, "prisma">, card: {
  id: string; description: string; labels: string[]; priority: string | null; assigneeId: string | null; createdAt: Date;
  column: { title: string; boardId: string };
}) {
  const column = etaColumn(card.column.title);
  if (!column) return null;
  const finished = await finishedHours(deps, card.column.boardId);
  const boardMedian = median(finished.map((f) => f.hours)) ?? PRIOR_MEDIAN_HOURS;
  const assigneeMedian = card.assigneeId ? median(finished.filter((f) => f.assigneeId === card.assigneeId).map((f) => f.hours)) : null;
  const openForAssignee = card.assigneeId
    ? await deps.prisma.card.count({ where: { assigneeId: card.assigneeId, column: { boardId: card.column.boardId, NOT: { title: { contains: "done", mode: "insensitive" } } } } })
    : 0;
  return {
    column,
    labels: [...card.labels.filter((l) => ["bug", "feature", "chore"].includes(l)), ...(card.priority === "urgent" ? ["urgent"] : [])],
    description_length: card.description.length,
    comments: 0, // ponytail: PulseBoard cards have no comments or checklists yet; 0 until they do
    checklist_items: 0,
    assignee_median_hours: Math.round((assigneeMedian ?? boardMedian) * 10) / 10,
    board_median_hours: Math.round(boardMedian * 10) / 10,
    day_of_week: (card.createdAt.getUTCDay() + 6) % 7, // Monday = 0
    open_cards_assignee: openForAssignee,
  };
}

/** GET /cards/:id/eta → {p50Hours, p90Hours} | {done: true}. 503 when no ETA server is configured or reachable. */
export async function cardEta(deps: Deps, userId: string, cardId: string) {
  const card = await deps.prisma.card.findUnique({ where: { id: cardId }, include: { column: { select: { title: true, boardId: true } } } });
  if (!card) throw new HttpError(404, "card not found");
  await requireRole(deps, card.column.boardId, userId, false);
  const url = process.env.ETA_URL;
  if (!url) throw new HttpError(503, "completion-time model not configured");
  const features = await etaFeatures(deps, card);
  if (!features) return { done: true };
  const res = await fetch(`${url}/predict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(features),
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!res?.ok) throw new HttpError(503, "completion-time model unavailable");
  const { p50Hours, p90Hours } = (await res.json()) as { p50Hours: number; p90Hours: number };
  return { p50Hours, p90Hours };
}
