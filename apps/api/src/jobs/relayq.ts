import { HttpError } from "../http.js";

// Client for RelayQ (../relayq). Payload shapes must match its zod schemas in src/queue/queues.ts.
export type JobPayloads = {
  "board.export": { boardId: string; format: "csv" | "json"; callbackUrl: string };
  "email.digest": { to: string; userName: string; items: { title: string; url?: string }[] };
};

const TIMEOUT_MS = 5000;

// RelayQ unreachable / 5xx → 503 (try again later). RelayQ 4xx means we sent something wrong → 502.
export async function enqueue<T extends keyof JobPayloads>(type: T, payload: JobPayloads[T], idempotencyKey?: string) {
  const base = process.env.RELAYQ_URL;
  if (!base) throw new HttpError(503, "job queue not configured");
  let res: Response;
  try {
    res = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RELAYQ_API_KEY ?? ""}` },
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
