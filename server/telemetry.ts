import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

export function startTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): NodeSDK | undefined {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const endpoint = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid telemetry endpoint");
  const sdk = new NodeSDK({
    serviceName: "homelab-dashboard",
    autoDetectResources: false,
    // Manual route spans avoid recording OIDC callback URLs, query strings,
    // cookies, request bodies, user identity or upstream authorization headers.
    instrumentations: [],
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.href.replace(/\/$/, "")}/v1/traces`,
      timeoutMillis: 3000,
    }),
  });
  sdk.start();
  return sdk;
}
export function requestSpan(method: string, route: string): Span {
  const safeMethod = [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ].includes(method)
    ? method
    : "OTHER";
  // Only framework route templates are accepted; never raw request.url.
  return trace
    .getTracer("homelab-dashboard")
    .startSpan(`${safeMethod} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": safeMethod, "http.route": route },
    });
}
export function endRequestSpan(span: Span, status: number): void {
  span.setAttribute("http.response.status_code", status);
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
