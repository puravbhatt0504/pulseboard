import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// Manual spans; no-ops when no SDK is registered (OTEL_EXPORTER_OTLP_ENDPOINT unset, most tests).
export const tracer = trace.getTracer("pulseboard-api");

/** Adds traceparent (and tracestate) for the active span to outgoing headers, so RelayQ continues our trace. */
export function injectTrace(headers: Record<string, string>) {
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * A Socket.io handler run inside a `socket.<event>` span, so its Prisma/Redis spans have a parent.
 * Not used for cursor/awareness: 20 messages a second per user would bury every other trace.
 */
export const traced =
  <A extends unknown[]>(event: string, fn: (...args: A) => unknown) =>
  (...args: A) =>
    tracer.startActiveSpan(`socket.${event}`, { kind: SpanKind.SERVER }, async (span) => {
      try {
        await fn(...args);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
