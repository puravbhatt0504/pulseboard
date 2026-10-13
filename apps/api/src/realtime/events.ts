import type { Card, Role } from "@prisma/client";
import type { Server } from "socket.io";

// `ts` = server send time (ms), so clients can measure broadcast latency.
export type CardEvent = { card: Card; by: string; ts: number };
export type PresenceUser = { id: string; name: string; color: string };

export interface ServerToClient {
  "card:created": (p: CardEvent) => void;
  "card:updated": (p: CardEvent) => void;
  "card:moved": (p: CardEvent) => void;
  "card:deleted": (p: CardEvent) => void;
  "presence:update": (p: { users: PresenceUser[] }) => void;
  cursors: (p: { cursors: { userId: string; x: number; y: number }[] }) => void; // includes the receiver's own; skip it
  "export:ready": (p: { jobId: string; url: string }) => void;
  error: (p: { code: "forbidden" | "bad_request" }) => void;
  "doc:update": (p: { cardId: string; update: Uint8Array }) => void;
  "doc:awareness": (p: { cardId: string; update: Uint8Array }) => void; // y-protocols awareness (editor carets)
}

export type DocJoinAck = { update: Uint8Array; sv: Uint8Array; readOnly: boolean } | { error: "forbidden" | "bad_request" };

export interface ClientToServer {
  join_board: (p: { boardId: string }) => void;
  cursor: (p: { x: number; y: number }) => void;
  "doc:join": (p: { cardId: string; sv?: Uint8Array }, ack: (r: DocJoinAck) => void) => void;
  "doc:update": (p: { cardId: string; update: Uint8Array }) => void;
  "doc:awareness": (p: { cardId: string; update: Uint8Array }) => void;
  "doc:leave": (p: { cardId: string }) => void;
}

export type SocketData = { userId: string; boardId?: string; cards?: Map<string, Role> };
export type IO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export const room = (boardId: string) => `board:${boardId}`;

export function emitCard(io: IO | undefined, boardId: string, event: "card:created" | "card:updated" | "card:moved" | "card:deleted", card: Card, by: string) {
  io?.to(room(boardId)).emit(event, { card, by, ts: Date.now() });
}
