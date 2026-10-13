// Load before the app: node --import ./dist/otel.js dist/index.js (same setup as RelayQ's src/otel.ts).
// Does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://jaeger:4318).
import { register } from "node:module";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // ESM: auto-instrumentation patches modules through this loader hook, so it must be registered first.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  // sdk-trace-node, not sdk-node: the latter brings gRPC, metrics, logs and zipkin exporters we don't use (image size).
  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { resourceFromAttributes },
    { registerInstrumentations },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { ExpressInstrumentation },
    { IORedisInstrumentation },
    { PrismaInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-ioredis"),
    import("@prisma/instrumentation"),
  ]);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "pulseboard-api" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register(); // AsyncLocalStorage context + W3C traceparent propagation
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /^(\/api)?\/health/.test(req.url ?? "") }),
      new ExpressInstrumentation(),
      // No undici (fetch) instrumentation: the only fetch is the RelayQ enqueue, which injects traceparent itself
      // (tracing.ts injectTrace). Both would send two traceparent headers, which RelayQ reads as one invalid value.
      // The socket.io Redis adapter and presence touch Redis constantly; keep only spans under a request or socket event.
      new IORedisInstrumentation({ requireParentSpan: true }),
      new PrismaInstrumentation(),
    ],
  });
  process.once("beforeExit", () => void provider.shutdown());
}
