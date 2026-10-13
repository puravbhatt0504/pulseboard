import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http.js";
import { injectTrace } from "../tracing.js";

// Client for RelayQ (../relayq). Payload shapes must match its zod schemas in src/queue/queues.ts.
export type JobPayloads = {
  "board.export": { boardId: string; format: "csv" | "json"; callbackUrl: string };
  "email.digest": { to: string; userName: string; items: { title: string; url?: string }[] };
  "embed.batch": { items: { id: string; text: string }[]; model: string; callbackUrl: string };
};

const TIMEOUT_MS = 5000;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// RelayQ's board.export worker authenticates to PulseBoard with this shared token (its PULSEBOARD_TOKEN).
export function isRelayqService(authorization: string | undefined) {
  const token = process.env.RELAYQ_SERVICE_TOKEN;
  return !!token && !!authorization && safeEqual(authorization, `Bearer ${token}`);
}

// Callbacks carry x-relayq-signature = hex HMAC-SHA256(raw body, WEBHOOK_SECRET), as in RelayQ's sign().
export function verifyRelayqSignature(rawBody: Buffer | undefined, signature: unknown) {
  const secret = process.env.RELAYQ_WEBHOOK_SECRET;
  if (!secret || !rawBody || typeof signature !== "string") return false;
  return safeEqual(createHmac("sha256", secret).update(rawBody).digest("hex"), signature);
}

// RelayQ unreachable / 5xx → 503 (try again later). RelayQ 4xx means we sent something wrong → 502.
export async function enqueue<T extends keyof JobPayloads>(type: T, payload: JobPayloads[T], idempotencyKey?: string) {
  const base = process.env.RELAYQ_URL;
  if (!base) throw new HttpError(503, "job queue not configured");
  let res: Response;
  try {
    res = await fetch(`${base}/jobs`, {
      method: "POST",
      // traceparent: RelayQ stores it with the job, so its worker and the callback join this request's trace.
      headers: injectTrace({ "content-type": "application/json", authorization: `Bearer ${process.env.RELAYQ_API_KEY ?? ""}` }),
      body: JSON.stringify({ type, payload, idempotencyKey }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, "job queue unavailable");
  }
  if (res.status >= 500) throw new HttpError(503, "job queue unavailable");
  if (!res.ok) {
    console.error(`relayq rejected ${type}: ${res.status} ${await res.text().catch(() => "")}`);
    throw new HttpError(502, "job queue rejected the request");
  }
  const { jobId } = (await res.json()) as { jobId: string };
  return { jobId };
}
