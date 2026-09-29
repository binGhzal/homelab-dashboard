import { open } from "node:fs/promises";
import https from "node:https";

export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
export const MAX_DISCOVERY_ROUTES = 100;
const API_ORIGIN = "https://kubernetes.default.svc";
const TOKEN_PATH = "/var/run/secrets/dashboard-discovery/token";
const CA_PATH = "/var/run/secrets/dashboard-discovery/ca.crt";
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PAGES_PER_NAMESPACE = 5;

export type DiscoveryFileReader = (
  path: string,
  signal: AbortSignal,
) => Promise<string | Buffer>;
export type RouteFetcher = (
  namespaces: readonly string[],
  signal: AbortSignal,
) => Promise<unknown[]>;
export interface KubernetesDiscoveryDependencies {
  readFile?: DiscoveryFileReader;
  request?: typeof https.request;
}

function unavailable(): Error {
  return new Error("DISCOVERY_UNAVAILABLE");
}

export async function readBoundedDiscoveryFile(
  path: string,
  signal: AbortSignal,
  maximum = MAX_DISCOVERY_BYTES,
): Promise<Buffer> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw unavailable();
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        size,
        maximum + 1 - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal.throwIfAborted();
    if (size > maximum) throw unavailable();
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createKubernetesRouteFetcher(
  dependencies: KubernetesDiscoveryDependencies = {},
): RouteFetcher {
  const request = dependencies.request ?? https.request;
  const readFile =
    dependencies.readFile ??
    ((path: string, signal: AbortSignal) =>
      readBoundedDiscoveryFile(path, signal, 256 * 1024));

  async function page(url: URL, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    // Projected service-account tokens rotate. Read both files for every GET.
    const [tokenValue, caValue] = await Promise.all([
      readFile(TOKEN_PATH, signal),
      readFile(CA_PATH, signal),
    ]);
    const token = tokenValue.toString().trim();
    const ca = Buffer.isBuffer(caValue) ? caValue : Buffer.from(caValue);
    if (
      !token ||
      token.length > 16384 ||
      !/^[A-Za-z0-9._~-]+$/.test(token) ||
      !ca.length ||
      ca.length > 256 * 1024
    )
      throw unavailable();
    signal.throwIfAborted();
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (body?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (body) resolve(body);
        else reject(unavailable());
      };
      const outgoing = request(
        url,
        {
          method: "GET",
          ca,
          rejectUnauthorized: true,
          agent: false,
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers["content-type"] ?? "",
            )
          ) {
            // Redirects are never followed, including redirects to this origin.
            response.destroy();
            finish();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_DISCOVERY_BYTES) {
              response.destroy();
              outgoing.destroy();
              finish();
            } else chunks.push(chunk);
          });
          response.on("end", () => finish(Buffer.concat(chunks)));
          response.on("error", () => finish());
          response.on("aborted", () => finish());
        },
      );
      outgoing.on("error", () => finish());
      timer = setTimeout(() => {
        outgoing.destroy();
        finish();
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      outgoing.end();
    });
  }

  return async (namespaces, signal) => {
    try {
      if (
        namespaces.length === 0 ||
        namespaces.length > 32 ||
        namespaces.some((namespace) => !NAMESPACE.test(namespace)) ||
        new Set(namespaces).size !== namespaces.length
      )
        throw unavailable();
      const routes: unknown[] = [];
      let bytes = 0;
      for (const namespace of namespaces) {
        let continuation = "";
        const seen = new Set<string>();
        for (let index = 0; ; index++) {
          if (index >= MAX_PAGES_PER_NAMESPACE) throw unavailable();
          const url = new URL(
            `/apis/gateway.networking.k8s.io/v1/namespaces/${namespace}/httproutes`,
            API_ORIGIN,
          );
          url.searchParams.set(
            "labelSelector",
            "homelab-dashboard.io/discover=true",
          );
          url.searchParams.set("limit", String(MAX_DISCOVERY_ROUTES));
          if (continuation) url.searchParams.set("continue", continuation);
          const body = await page(url, signal);
          bytes += body.length;
          if (bytes > MAX_DISCOVERY_BYTES) throw unavailable();
          const data: unknown = JSON.parse(body.toString("utf8"));
          if (
            !record(data) ||
            data.apiVersion !== "gateway.networking.k8s.io/v1" ||
            data.kind !== "HTTPRouteList" ||
            !Array.isArray(data.items) ||
            (data.metadata !== undefined && !record(data.metadata))
          )
            throw unavailable();
          routes.push(...data.items);
          if (routes.length > MAX_DISCOVERY_ROUTES) throw unavailable();
          const next = record(data.metadata)
            ? data.metadata.continue
            : undefined;
          if (next === undefined || next === "") break;
          if (typeof next !== "string" || next.length > 2048 || seen.has(next))
            throw unavailable();
          seen.add(next);
          continuation = next;
        }
      }
      return routes;
    } catch {
      throw unavailable();
    }
  };
}
