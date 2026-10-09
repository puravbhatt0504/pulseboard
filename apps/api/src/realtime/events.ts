import type { Card } from "@prisma/client";
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
  cursor: (p: { userId: string; x: number; y: number }) => void;
  error: (p: { code: "forbidden" | "bad_request" }) => void;
}

export interface ClientToServer {
  join_board: (p: { boardId: string }) => void;
  cursor: (p: { x: number; y: number }) => void;
}

export type SocketData = { userId: string; boardId?: string };
export type IO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export const room = (boardId: string) => `board:${boardId}`;

export function emitCard(io: IO | undefined, boardId: string, event: "card:created" | "card:updated" | "card:moved" | "card:deleted", card: Card, by: string) {
  io?.to(room(boardId)).emit(event, { card, by, ts: Date.now() });
}
