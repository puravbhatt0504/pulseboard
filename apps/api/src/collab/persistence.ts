import * as Y from "yjs";
import type { Deps } from "../app.js";

/** The editor binds Y.XmlFragment "description" (TipTap Collaboration `field`). */
export const FIELD = "description";

/** Plain text of the editor fragment: block elements on their own lines, formatting dropped. */
export function plainText(doc: Y.Doc): string {
  const walk = (n: Y.XmlElement | Y.XmlFragment | Y.XmlText): string =>
    n instanceof Y.XmlText
      ? (n.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("")
      : n.toArray().map((c) => walk(c as Y.XmlElement | Y.XmlText)).join(n instanceof Y.XmlFragment ? "\n" : "");
  return walk(doc.getXmlFragment(FIELD));
}

/** Initial doc for a card that predates collaboration: one paragraph per line of its description. */
function seed(description: string): Uint8Array {
  const doc = new Y.Doc();
  if (description) {
    doc.getXmlFragment(FIELD).insert(0, description.split("\n").map((line) => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(line)]);
      return p;
    }));
  }
  return Y.encodeStateAsUpdate(doc);
}

/** Stored state for a card, creating it once (insert-or-ignore, so two instances can't seed twice). null = no card. */
export async function loadState({ prisma }: Pick<Deps, "prisma">, cardId: string): Promise<Uint8Array | null> {
  const existing = await prisma.cardDoc.findUnique({ where: { cardId } });
  if (existing) return existing.state;
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { description: true } });
  if (!card) return null;
  await prisma.cardDoc.createMany({ data: [{ cardId, state: Buffer.from(seed(card.description)) }], skipDuplicates: true });
  return (await prisma.cardDoc.findUniqueOrThrow({ where: { cardId } })).state;
}

/**
 * Merge `doc` into the stored state under a row lock and write it back with the plain-text projection.
 * Merging (not overwriting) means instances that each hold part of the history never drop each other's edits;
 * `doc` also receives whatever another instance persisted. The stored state is a full encodeStateAsUpdate, so it
 * never grows as an update log and needs no separate compaction.
 */
export async function saveState({ prisma }: Pick<Deps, "prisma">, cardId: string, doc: Y.Doc): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ state: Uint8Array }[]>`SELECT state FROM "CardDoc" WHERE "cardId" = ${cardId} FOR UPDATE`;
    if (rows[0]) Y.applyUpdate(doc, rows[0].state);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    await tx.cardDoc.upsert({ where: { cardId }, create: { cardId, state }, update: { state } });
    await tx.card.update({ where: { id: cardId }, data: { description: plainText(doc) } });
  });
}
