import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { enqueue } from "./jobs/relayq.js";
import { traced, tracer } from "./tracing.js";

const exporter = new InMemorySpanExporter();
let relayq: Server;
const seen: (string | undefined)[] = [];

beforeAll(async () => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  // Stand-in RelayQ: records the traceparent of each POST /jobs.
  relayq = createServer((req, res) => {
    seen.push(req.headers.traceparent as string | undefined);
    req.resume().on("end", () => res.writeHead(202, { "content-type": "application/json" }).end('{"jobId":"j1"}'));
  });
  await new Promise<void>((r) => relayq.listen(0, r));
  process.env.RELAYQ_URL = `http://localhost:${(relayq.address() as AddressInfo).port}`;
});

afterAll(() => {
  relayq.close();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("tracing", () => {
  it("the RelayQ enqueue request carries a traceparent with the active span's trace id", async () => {
    const traceId = await tracer.startActiveSpan("export", async (span) => {
      await enqueue("board.export", { boardId: "b", format: "csv", callbackUrl: "http://x/cb" });
      span.end();
      return span.spanContext().traceId;
    });
    expect(seen.at(-1)).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  });

  it("a socket handler runs in a socket.<event> span, and a throw marks it as an error", async () => {
    let inner = "";
    await traced("doc:join", async () => void (inner = trace.getActiveSpan()!.spanContext().spanId))();
    await expect(traced("doc:update", async () => { throw new Error("boom"); })()).rejects.toThrow("boom");
    const spans = exporter.getFinishedSpans();
    const join = spans.find((s) => s.name === "socket.doc:join")!;
    expect(join.spanContext().spanId).toBe(inner);
    expect(spans.find((s) => s.name === "socket.doc:update")!.status.code).toBe(SpanStatusCode.ERROR);
  });
});
