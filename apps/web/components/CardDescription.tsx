"use client";

import { useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";

type JoinAck = { update: ArrayBuffer; sv: ArrayBuffer; readOnly: boolean } | { error: string };
const REMOTE = Symbol("remote");

/**
 * Collaborative card description (Yjs doc "description", synced over the board socket; see api collab/yjs-server.ts).
 * The doc also lives in IndexedDB, so edits made offline survive reloads and are sent when the socket reconnects:
 * join sends our state vector, applies what the server has that we lack, then sends what it lacks.
 */
export function CardDescription({ socket, cardId, user }: { socket: Socket; cardId: string; user: { name: string; color: string } }) {
  const doc = useMemo(() => new Y.Doc(), [cardId]);
  // ponytail: never destroy()ed (strict mode reuses it); its 3 s check interval outlives the panel until GC of the doc.
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  const [status, setStatus] = useState<"syncing" | "live" | "offline" | "forbidden">("syncing");
  // Editable until the server says otherwise; it drops a viewer's updates regardless.
  const [readOnly, setReadOnly] = useState(false);

  const editor = useEditor(
    {
      extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc, field: "description" }),
        CollaborationCaret.configure({ provider: { awareness }, user }),
      ],
      editable: false,
      immediatelyRender: false,
      editorProps: { attributes: { class: "min-h-32 rounded border border-zinc-300 bg-white p-3 text-sm focus:outline-none", "data-testid": "description-editor" } },
    },
    [doc],
  );
  useEffect(() => editor?.setEditable(!readOnly), [editor, readOnly]);
  useEffect(
    () => awareness.setLocalState({ ...awareness.getLocalState(), user: { name: user.name, color: user.color } }),
    [awareness, user.name, user.color],
  );

  useEffect(() => {
    const idb = new IndexeddbPersistence(`pulseboard:card:${cardId}`, doc);
    let joined = false;
    const onLocal = (update: Uint8Array, origin: unknown) => {
      if (joined && origin !== REMOTE && origin !== idb) socket.emit("doc:update", { cardId, update });
    };
    const onRemote = (p: { cardId: string; update: ArrayBuffer }) => {
      if (p.cardId === cardId) Y.applyUpdate(doc, new Uint8Array(p.update), REMOTE);
    };
    type Change = { added: number[]; updated: number[]; removed: number[] };
    const sendAwareness = (clients: number[]) =>
      joined && socket.emit("doc:awareness", { cardId, update: encodeAwarenessUpdate(awareness, clients) });
    const onAwareness = ({ added, updated, removed }: Change, origin: unknown) => {
      if (origin === "local") sendAwareness([...added, ...updated, ...removed]);
      else if (added.length) sendAwareness([doc.clientID]); // a newcomer: tell them where we are
    };
    const onRemoteAwareness = (p: { cardId: string; update: ArrayBuffer }) => {
      if (p.cardId === cardId) applyAwarenessUpdate(awareness, new Uint8Array(p.update), REMOTE);
    };
    const join = async () => {
      await idb.whenSynced;
      socket.emit("doc:join", { cardId, sv: Y.encodeStateVector(doc) }, (ack: JoinAck) => {
        if ("error" in ack) return setStatus("forbidden");
        Y.applyUpdate(doc, new Uint8Array(ack.update), REMOTE);
        const missing = Y.encodeStateAsUpdate(doc, new Uint8Array(ack.sv));
        if (!ack.readOnly && missing.length > 2) socket.emit("doc:update", { cardId, update: missing });
        joined = true;
        setReadOnly(ack.readOnly);
        setStatus("live");
        sendAwareness([doc.clientID]);
      });
    };
    const onDisconnect = () => {
      joined = false;
      // Everyone else's carets are stale now; the server forgets nothing (it never stored them).
      removeAwarenessStates(awareness, [...awareness.getStates().keys()].filter((c) => c !== doc.clientID), REMOTE);
      setStatus("offline");
    };

    doc.on("update", onLocal);
    awareness.on("update", onAwareness);
    socket.on("doc:update", onRemote);
    socket.on("doc:awareness", onRemoteAwareness);
    socket.on("connect", join);
    socket.on("disconnect", onDisconnect);
    if (socket.connected) void join();
    else onDisconnect();
    return () => {
      removeAwarenessStates(awareness, [doc.clientID], "local"); // our caret disappears for the others
      if (joined) socket.emit("doc:leave", { cardId });
      doc.off("update", onLocal);
      awareness.off("update", onAwareness);
      socket.off("doc:update", onRemote);
      socket.off("doc:awareness", onRemoteAwareness);
      socket.off("connect", join);
      socket.off("disconnect", onDisconnect);
      void idb.destroy(); // not doc.destroy(): React dev mode re-runs this effect with the same doc
    };
  }, [socket, cardId, doc, awareness]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
        <span>Description</span>
        <span data-testid="description-status">
          {status === "live" ? (readOnly ? "read only" : "live") : status === "offline" ? "offline: saved on this device" : status}
        </span>
      </div>
      {status === "forbidden" ? <p className="text-sm text-red-700">You can't open this card.</p> : <EditorContent editor={editor} />}
    </div>
  );
}
