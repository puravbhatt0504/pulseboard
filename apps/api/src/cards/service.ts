import type { Deps } from "../app.js";
import { HttpError } from "../http.js";
import { requireRole, invalidateBoard } from "../boards/service.js";
import { between } from "./position.js";

export type CardPatch = { title?: string; description?: string; columnId?: string; before?: string; after?: string };

async function columnBoard({ prisma }: Deps, columnId: string) {
  const col = await prisma.column.findUnique({ where: { id: columnId }, select: { boardId: true } });
  if (!col) throw new HttpError(404, "column not found");
  return col.boardId;
}

// Resolves a card's board and checks the caller's role on it.
export async function cardBoard(deps: Deps, userId: string, cardId: string, write: boolean) {
  const card = await deps.prisma.card.findUnique({ where: { id: cardId }, select: { column: { select: { boardId: true } } } });
  if (!card) throw new HttpError(404, "card not found");
  await requireRole(deps, card.column.boardId, userId, write);
  return card.column.boardId;
}

export async function createCard(deps: Deps, userId: string, columnId: string, title: string, description = "") {
  const { prisma } = deps;
  const boardId = await columnBoard(deps, columnId);
  await requireRole(deps, boardId, userId, true);
  const last = await prisma.card.findFirst({ where: { columnId }, orderBy: { position: "desc" } });
  const [card] = await prisma.$transaction([
    prisma.card.create({ data: { columnId, title, description, position: between(last?.position ?? null, null) } }),
    prisma.activity.create({ data: { boardId, userId, type: "card.created", data: { columnId, title } } }),
  ]);
  await invalidateBoard(deps, boardId);
  return { card, boardId };
}

// `before` = id of the card that ends up directly above this one, `after` = directly below.
// Either may be omitted; the missing neighbour is read from the DB. Neither + new column = append.
export async function updateCard(deps: Deps, userId: string, cardId: string, patch: CardPatch) {
  const { prisma } = deps;
  const current = await prisma.card.findUnique({ where: { id: cardId }, include: { column: { select: { boardId: true } } } });
  if (!current) throw new HttpError(404, "card not found");
  const boardId = current.column.boardId;
  await requireRole(deps, boardId, userId, true);

  const columnId = patch.columnId ?? current.columnId;
  if (columnId !== current.columnId && (await columnBoard(deps, columnId)) !== boardId) {
    throw new HttpError(400, "column belongs to another board");
  }

  let position = current.position;
  const moved = patch.before !== undefined || patch.after !== undefined || columnId !== current.columnId;
  if (moved) {
    const neighbour = async (id: string | undefined) => {
      if (id === undefined) return undefined;
      const s = await prisma.card.findUnique({ where: { id } });
      if (!s || s.columnId !== columnId || s.id === cardId) {
        throw new HttpError(400, "before/after must be other cards in the target column");
      }
      return s.position;
    };
    const others = { columnId, id: { not: cardId } };
    let lo = await neighbour(patch.before);
    let hi = await neighbour(patch.after);
    if (lo !== undefined && hi === undefined) {
      hi = (await prisma.card.findFirst({ where: { ...others, position: { gt: lo } }, orderBy: { position: "asc" } }))?.position;
    } else if (hi !== undefined && lo === undefined) {
      lo = (await prisma.card.findFirst({ where: { ...others, position: { lt: hi } }, orderBy: { position: "desc" } }))?.position;
    } else if (lo === undefined && hi === undefined) {
      lo = (await prisma.card.findFirst({ where: others, orderBy: { position: "desc" } }))?.position;
    }
    try {
      // ponytail: two concurrent moves into the same gap can get equal positions; reads tie-break on id.
      position = between(lo ?? null, hi ?? null);
    } catch {
      throw new HttpError(400, "before must be above after");
    }
  }

  const [card] = await prisma.$transaction([
    prisma.card.update({
      where: { id: cardId },
      data: { title: patch.title, description: patch.description, columnId, position },
    }),
    prisma.activity.create({
      data: { boardId, userId, type: moved ? "card.moved" : "card.updated", data: { cardId, columnId } },
    }),
  ]);
  await invalidateBoard(deps, boardId);
  return { card, boardId, moved };
}
