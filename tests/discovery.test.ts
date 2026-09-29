import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscovery,
  loadDiscoveryConfig,
  type DiscoveryConfig,
  type DiscoveryProvider,
} from "../server/discovery.js";
import {
  createKubernetesRouteFetcher,
  MAX_DISCOVERY_BYTES,
  readBoundedDiscoveryFile,
} from "../server/kubernetes-discovery.js";

const INITIAL_TIME = Date.parse("2026-09-29T12:00:00Z");
const config: DiscoveryConfig = {
  mode: "kubernetes",
  namespaces: ["media"],
  pollSeconds: 30,
  maxAgeSeconds: 90,
};
const annotation = {
  id: "media-player",
  name: "Media Player",
  access: { anyOf: [{ allOf: ["media-members"] }] },
};
interface SyntheticParentRef {
  name: string;
  namespace?: string;
  group?: string;
  kind?: string;
  sectionName?: string;
  port?: number;
}
function route(app: Record<string, unknown> = annotation) {
  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: {
      name: "media-player",
      namespace: "media",
      generation: 7,
      labels: { "homelab-dashboard.io/discover": "true" },
      annotations: { "homelab-dashboard.io/app": JSON.stringify(app) },
    },
    spec: {
      hostnames: ["media.example.test"],
      parentRefs: [{ name: "gateway" } as SyntheticParentRef],
    },
    status: {
      parents: [
        {
          parentRef: { name: "gateway" } as SyntheticParentRef,
          conditions: [
            { type: "Accepted", status: "True", observedGeneration: 7 },
            { type: "ResolvedRefs", status: "True", observedGeneration: 7 },
          ],
        },
      ],
    },
  };
}
function envelope(items: unknown[], generatedAt = INITIAL_TIME): string {
  return JSON.stringify({
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    items,
  });
}
const providers: DiscoveryProvider[] = [];
function provider(...args: Parameters<typeof createDiscovery>) {
  const result = createDiscovery(...args);
  providers.push(result);
  return result;
}
afterEach(() => {
  for (const item of providers.splice(0)) item.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discovery configuration", () => {
  it("is disabled by default and requires explicit namespaces when enabled", () => {
    expect(loadDiscoveryConfig({})).toBeUndefined();
    expect(() =>
      loadDiscoveryConfig({ DASHBOARD_DISCOVERY_MODE: "kubernetes" }),
    ).toThrow("Invalid dashboard discovery configuration");
    expect(
      loadDiscoveryConfig({
        DASHBOARD_DISCOVERY_MODE: "kubernetes",
        DASHBOARD_DISCOVERY_NAMESPACES: "media, tools",
      }),
    ).toEqual({
      ...config,
      namespaces: ["media", "tools"],
    });
  });
  it.each([
    { DASHBOARD_DISCOVERY_MODE: "other" },
    { DASHBOARD_DISCOVERY_NAMESPACES: "media,media" },
    { DASHBOARD_DISCOVERY_NAMESPACES: "Media" },
    { DASHBOARD_DISCOVERY_NAMESPACES: "media/*" },
    { DASHBOARD_DISCOVERY_NAMESPACES: "media," },
    { DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "9" },
    { DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "301" },
    { DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "NaN" },
    { DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "30.5" },
    { DASHBOARD_DISCOVERY_MAX_AGE_SECONDS: "29" },
    { DASHBOARD_DISCOVERY_MAX_AGE_SECONDS: "901" },
    { DASHBOARD_DISCOVERY_MODE: "file" },
    {
      DASHBOARD_DISCOVERY_MODE: "file",
      DASHBOARD_DISCOVERY_FILE: "relative.json",
    },
  ])("rejects invalid bounded configuration %j", (overrides) => {
    expect(() =>
      loadDiscoveryConfig({
        DASHBOARD_DISCOVERY_MODE: "kubernetes",
        DASHBOARD_DISCOVERY_NAMESPACES: "media",
        ...overrides,
      }),
    ).toThrow("Invalid dashboard discovery configuration");
  });
  it("accepts an explicit absolute file and boundary intervals", () => {
    expect(
      loadDiscoveryConfig({
        DASHBOARD_DISCOVERY_MODE: "file",
        DASHBOARD_DISCOVERY_NAMESPACES: "media",
        DASHBOARD_DISCOVERY_FILE: "/tmp/synthetic-routes.json",
        DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "300",
        DASHBOARD_DISCOVERY_MAX_AGE_SECONDS: "900",
      }),
    ).toEqual({
      mode: "file",
      namespaces: ["media"],
      file: "/tmp/synthetic-routes.json",
      pollSeconds: 300,
      maxAgeSeconds: 900,
    });
  });
});

describe("route validation and snapshots", () => {
  it("discovers an explicit access policy and preserves the admin path and icon metadata", async () => {
    const item = provider(config, {
      clock: () => INITIAL_TIME,
      fetchRoutes: async () => [
        route({
          ...annotation,
          path: "/admin/",
          iconSlug: "media-player",
          iconSource: "selfhst",
        }),
      ],
    });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({
      state: "ready",
      lastSuccessfulSync: "2026-09-29T12:00:00.000Z",
      rejectedRoutes: 0,
      namespaces: ["media"],
      refreshIntervalSeconds: 30,
    });
    expect(item.snapshot().apps).toEqual([
      expect.objectContaining({
        id: "media-player",
        href: "https://media.example.test/admin/",
        iconSlug: "media-player",
        iconSource: "selfhst",
        access: { allowAdmin: false, anyOf: [{ allOf: ["media-members"] }] },
      }),
    ]);
  });
  it("applies additions, changes and removals without retaining old apps", async () => {
    let items = [route()];
    const item = provider(config, { fetchRoutes: async () => items });
    await item.refresh();
    items = [
      route({ ...annotation, id: "other", name: "Other", path: "/new" }),
    ];
    await item.refresh();
    expect(item.snapshot().apps.map((app) => [app.id, app.href])).toEqual([
      ["other", "https://media.example.test/new"],
    ]);
    items = [];
    await item.refresh();
    expect(item.snapshot()).toMatchObject({
      state: "ready",
      apps: [],
      rejectedRoutes: 0,
    });
  });
  it("returns detached snapshots so consumers cannot mutate access or namespaces", async () => {
    const item = provider(config, { fetchRoutes: async () => [route()] });
    await item.refresh();
    const snapshot = item.snapshot();
    snapshot.apps[0].access.anyOf[0].allOf[0] = "administrators";
    snapshot.namespaces.push("outside");
    expect(item.snapshot().apps[0].access.anyOf[0].allOf).toEqual([
      "media-members",
    ]);
    expect(item.snapshot().namespaces).toEqual(["media"]);
  });
  it.each([
    ["missing access", { id: "missing", name: "Missing" }],
    [
      "unknown annotation key",
      { ...annotation, href: "https://foreign.example.test" },
    ],
    [
      "untrusted icon path",
      { ...annotation, iconPath: "https://foreign.example.test/icon.svg" },
    ],
    ["group inference field", { ...annotation, groups: ["media-members"] }],
    ["invalid policy", { ...annotation, access: { anyOf: [{ allOf: [] }] } }],
    ["oversized annotation", { ...annotation, description: "x".repeat(8193) }],
  ])("rejects %s without inventing policy", async (_label, app) => {
    const item = provider(config, { fetchRoutes: async () => [route(app)] });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({
      state: "ready",
      apps: [],
      rejectedRoutes: 1,
    });
  });
  it.each([
    "//foreign.example.test",
    "https://foreign.example.test/",
    "/?token=x",
    "/#fragment",
    "/\\foreign",
    "/%5cforeign",
    "/%00",
    "/../admin",
    "/%2e%2e/admin",
    "/bad path",
    "/%zz",
  ])("rejects unsafe or malformed path %s", async (path) => {
    const item = provider(config, {
      fetchRoutes: async () => [route({ ...annotation, path })],
    });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    expect(item.snapshot().rejectedRoutes).toBe(1);
  });
  it.each([
    "*.example.test",
    "user@media.example.test",
    "media.example.test:443",
    "media.example.test/path",
    "Media.example.test",
    "media.example.test.",
    "127.0.0.1",
    "192.0.2.1",
    "[::1]",
    "::1",
    "127.1",
  ])("rejects non-exact hostname %s", async (hostname) => {
    const data = route();
    data.spec.hostnames = [hostname];
    const item = provider(config, { fetchRoutes: async () => [data] });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
  });
  it("requires an exact explicit lowercase hostname for multi-host routes", async () => {
    const data = route();
    data.spec.hostnames.push("second.example.test");
    const item = provider(config, { fetchRoutes: async () => [data] });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    for (const hostname of ["foreign.example.test", "SECOND.example.test"]) {
      data.metadata.annotations["homelab-dashboard.io/app"] = JSON.stringify({
        ...annotation,
        hostname,
      });
      await item.refresh();
      expect(item.snapshot().apps).toEqual([]);
    }
    data.metadata.annotations["homelab-dashboard.io/app"] = JSON.stringify({
      ...annotation,
      hostname: "second.example.test",
    });
    await item.refresh();
    expect(item.snapshot().apps[0].href).toBe("https://second.example.test/");
  });
  it("requires current Accepted and ResolvedRefs on the same parent", async () => {
    const data = route();
    const [accepted, resolved] = data.status.parents[0].conditions;
    const parentRef = { name: "gateway" };
    data.status.parents = [
      { parentRef, conditions: [accepted] },
      { parentRef, conditions: [resolved] },
    ];
    const item = provider(config, { fetchRoutes: async () => [data] });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents = [
      {
        parentRef,
        conditions: [accepted, { ...resolved, observedGeneration: 6 }],
      },
    ];
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents = [
      { parentRef, conditions: [accepted, { ...resolved, status: "False" }] },
    ];
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents = [
      {
        parentRef,
        conditions: [accepted, resolved, { ...accepted, status: "False" }],
      },
    ];
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents = [{ parentRef, conditions: [accepted, resolved] }];
    await item.refresh();
    expect(item.snapshot().apps).toHaveLength(1);
  });
  it("rejects stale removed parents and compares equivalent reference defaults", async () => {
    const data = route();
    data.status.parents[0].parentRef.name = "removed-gateway";
    const item = provider(config, { fetchRoutes: async () => [data] });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents[0].parentRef = {
      name: "gateway",
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      namespace: "media",
    } as (typeof data.status.parents)[0]["parentRef"];
    await item.refresh();
    expect(item.snapshot().apps).toHaveLength(1);
    data.spec.parentRefs = [
      { name: "gateway", sectionName: "https" },
    ] as typeof data.spec.parentRefs;
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents[0].parentRef = {
      name: "gateway",
      sectionName: "https",
    } as (typeof data.status.parents)[0]["parentRef"];
    await item.refresh();
    expect(item.snapshot().apps).toHaveLength(1);
  });
  it("matches explicit parent namespaces and ports without guessing omitted values", async () => {
    const data = route();
    data.spec.parentRefs = [{ name: "gateway", namespace: "edge", port: 443 }];
    const item = provider(config, { fetchRoutes: async () => [data] });
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents[0].parentRef = { name: "gateway", namespace: "edge" };
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
    data.status.parents[0].parentRef.port = 443;
    await item.refresh();
    expect(item.snapshot().apps).toHaveLength(1);
    data.status.parents[0].parentRef.port = 80;
    await item.refresh();
    expect(item.snapshot().apps).toEqual([]);
  });
  it("enforces opt-in, namespace, kind, version, generation and valid annotation JSON", async () => {
    const variants = Array.from({ length: 7 }, () => route());
    variants[0].metadata.namespace = "outside";
    variants[1].metadata.labels["homelab-dashboard.io/discover"] = "false";
    variants[2].kind = "Ingress";
    variants[3].apiVersion = "gateway.networking.k8s.io/v1beta1";
    variants[4].metadata.generation = 8;
    variants[5].metadata.annotations["homelab-dashboard.io/app"] = "{";
    variants[6].metadata.generation = 0;
    const item = provider(config, {
      fetchRoutes: async () => [...variants, null, []],
    });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({
      apps: [],
      rejectedRoutes: 9,
      state: "ready",
    });
  });
  it("drops all colliding discovered IDs while retaining unrelated valid apps", async () => {
    const item = provider(config, {
      fetchRoutes: async () => [
        route(),
        route(),
        route({ ...annotation, id: "unique" }),
      ],
    });
    await item.refresh();
    expect(item.snapshot().apps.map((app) => app.id)).toEqual(["unique"]);
    expect(item.snapshot().rejectedRoutes).toBe(2);
  });
  it("clears previous apps immediately on transport failure without exposing its error", async () => {
    const fetchRoutes = vi
      .fn()
      .mockResolvedValueOnce([route()])
      .mockRejectedValueOnce(new Error("synthetic-private-error-value"));
    const item = provider(config, { clock: () => INITIAL_TIME, fetchRoutes });
    await item.refresh();
    await expect(item.refresh()).resolves.toBeUndefined();
    expect(item.snapshot()).toEqual({
      apps: [],
      state: "unavailable",
      lastSuccessfulSync: "2026-09-29T12:00:00.000Z",
      rejectedRoutes: 0,
      namespaces: ["media"],
      refreshIntervalSeconds: 30,
    });
    expect(JSON.stringify(item.snapshot())).not.toContain(
      "synthetic-private-error-value",
    );
  });
  it("fails the entire oversized collection closed instead of returning a truncated catalog", async () => {
    const item = provider(config, {
      fetchRoutes: async () =>
        Array.from({ length: 101 }, (_, i) =>
          route({ ...annotation, id: `app-${i}` }),
        ),
    });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({
      apps: [],
      state: "unavailable",
      lastSuccessfulSync: null,
    });
  });
  it("expires snapshots at the age limit and refreshes back to ready", async () => {
    let now = INITIAL_TIME;
    const item = provider(config, {
      clock: () => now,
      fetchRoutes: async () => [route()],
    });
    await item.refresh();
    now += 89999;
    expect(item.snapshot().apps).toHaveLength(1);
    now += 1;
    expect(item.snapshot()).toMatchObject({ apps: [], state: "stale" });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({ state: "ready" });
    expect(item.snapshot().apps).toHaveLength(1);
  });
  it("fails closed when the clock moves backwards beyond its tolerance", async () => {
    let now = INITIAL_TIME;
    const item = provider(config, {
      clock: () => now,
      fetchRoutes: async () => [route()],
    });
    await item.refresh();
    now -= 30001;
    expect(item.snapshot()).toMatchObject({ state: "stale", apps: [] });
  });
});

describe("bounded file discovery", () => {
  const fileConfig: DiscoveryConfig = {
    ...config,
    mode: "file",
    file: "/tmp/synthetic-routes.json",
  };
  it("applies namespace filtering in file mode", async () => {
    const outside = route({ ...annotation, id: "outside" });
    outside.metadata.namespace = "outside";
    const readFile = vi.fn(async () => envelope([route(), outside]));
    const item = provider(fileConfig, { clock: () => INITIAL_TIME, readFile });
    await item.refresh();
    expect(readFile).toHaveBeenCalledWith(
      fileConfig.file,
      expect.any(AbortSignal),
    );
    expect(item.snapshot().apps.map((app) => app.id)).toEqual(["media-player"]);
    expect(item.snapshot().rejectedRoutes).toBe(1);
  });
  it("uses generatedAt age even while unchanged files are repeatedly read successfully", async () => {
    let now = INITIAL_TIME;
    let generated = INITIAL_TIME;
    const item = provider(fileConfig, {
      clock: () => now,
      readFile: async () => envelope([route()], generated),
    });
    await item.refresh();
    now += 60000;
    await item.refresh();
    now += 30000;
    expect(item.snapshot()).toMatchObject({ apps: [], state: "stale" });
    await item.refresh();
    expect(item.snapshot()).toMatchObject({ apps: [], state: "stale" });
    generated = now;
    await item.refresh();
    expect(item.snapshot().apps).toHaveLength(1);
    expect(item.snapshot().state).toBe("ready");
  });
  it.each([
    "{",
    JSON.stringify({
      version: 2,
      generatedAt: "2026-09-29T12:00:00Z",
      items: [],
    }),
    JSON.stringify({ version: 1, generatedAt: "yesterday", items: [] }),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-09-29T12:00:00Z",
      items: [],
      extra: true,
    }),
    " ".repeat(MAX_DISCOVERY_BYTES + 1),
    envelope([], INITIAL_TIME + 30001),
  ])(
    "rejects malformed, oversized or future file envelope %#",
    async (contents) => {
      const item = provider(fileConfig, {
        clock: () => INITIAL_TIME,
        readFile: async () => contents,
      });
      await item.refresh();
      expect(item.snapshot()).toMatchObject({ state: "unavailable", apps: [] });
    },
  );
  it("clears prior apps when its file disappears", async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce(envelope([route()]))
      .mockRejectedValueOnce(new Error("ENOENT synthetic-only"));
    const item = provider(fileConfig, { clock: () => INITIAL_TIME, readFile });
    await item.refresh();
    await item.refresh();
    expect(item.snapshot()).toMatchObject({ state: "unavailable", apps: [] });
  });
  it("bounds regular-file reads and honors pre-aborted reads", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "dashboard-discovery-test-"),
    );
    try {
      const path = join(directory, "routes.json");
      await writeFile(path, "12345");
      const signal = new AbortController().signal;
      expect((await readBoundedDiscoveryFile(path, signal, 5)).toString()).toBe(
        "12345",
      );
      await expect(readBoundedDiscoveryFile(path, signal, 4)).rejects.toThrow(
        "DISCOVERY_UNAVAILABLE",
      );
      await expect(readBoundedDiscoveryFile(directory, signal)).rejects.toThrow(
        "DISCOVERY_UNAVAILABLE",
      );
      await expect(
        readBoundedDiscoveryFile(path, AbortSignal.abort()),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("poll lifecycle", () => {
  it("fetches initially, serializes concurrent refreshes and stops polling", async () => {
    vi.useFakeTimers();
    let finish: ((items: unknown[]) => void) | undefined;
    const fetchRoutes = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = resolve;
        }),
    );
    const item = provider(config, { fetchRoutes });
    const started = item.start();
    const concurrent = item.refresh();
    expect(fetchRoutes).toHaveBeenCalledTimes(1);
    finish!([route()]);
    await Promise.all([started, concurrent]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchRoutes).toHaveBeenCalledTimes(2);
    const stopping = item.refresh();
    item.stop();
    finish!([route()]);
    await stopping;
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchRoutes).toHaveBeenCalledTimes(2);
    expect(item.snapshot()).toMatchObject({ state: "unavailable", apps: [] });
  });
  it("aborts a hung refresh by its bounded deadline and ignores a late result", async () => {
    vi.useFakeTimers();
    let finish: ((items: unknown[]) => void) | undefined;
    let signal: AbortSignal | undefined;
    const item = provider(config, {
      fetchRoutes: (_namespaces, receivedSignal) => {
        signal = receivedSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = item.refresh();
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(item.snapshot()).toMatchObject({ state: "unavailable", apps: [] });
    finish!([route()]);
    await Promise.resolve();
    expect(item.snapshot().apps).toEqual([]);
  });
});

interface SyntheticPage {
  status?: number;
  body?: string;
  type?: string;
  hang?: boolean;
}
function list(items: unknown[], continuation?: string) {
  return JSON.stringify({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRouteList",
    metadata: { ...(continuation ? { continue: continuation } : {}) },
    items,
  });
}
function syntheticTransport(pages: SyntheticPage[]) {
  const seen: { url: URL; options: https.RequestOptions }[] = [];
  const request = ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    seen.push({ url, options });
    const page = pages.shift();
    if (!page) throw new Error("Unexpected synthetic request");
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = vi.fn(() => outgoing);
    outgoing.end = vi.fn(() => {
      if (!page.hang)
        queueMicrotask(() => {
          const response = new EventEmitter() as IncomingMessage;
          response.statusCode = page.status ?? 200;
          response.headers = {
            "content-type": page.type ?? "application/json",
          };
          response.destroy = vi.fn(() => response);
          callback(response);
          response.emit("data", Buffer.from(page.body ?? list([])));
          response.emit("end");
        });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  }) as typeof https.request;
  return { seen, request };
}

describe("read-only Kubernetes transport", () => {
  it("uses only namespaced HTTPS GETs, rereads rotated credentials and escapes pagination", async () => {
    const transport = syntheticTransport([
      { body: list([route()], "next/opaque?value=1") },
      { body: list([]) },
      { body: list([]) },
    ]);
    let tokenRead = 0;
    const paths: string[] = [];
    const fetchRoutes = createKubernetesRouteFetcher({
      request: transport.request,
      readFile: async (path) => {
        paths.push(path);
        return path.endsWith("/token")
          ? `synthetic-token-${++tokenRead}`
          : "synthetic-ca";
      },
    });
    expect(
      await fetchRoutes(["media", "tools"], new AbortController().signal),
    ).toHaveLength(1);
    expect(transport.seen).toHaveLength(3);
    for (const [index, { url, options }] of transport.seen.entries()) {
      expect(url.origin).toBe("https://kubernetes.default.svc");
      expect(url.pathname).toBe(
        `/apis/gateway.networking.k8s.io/v1/namespaces/${index === 2 ? "tools" : "media"}/httproutes`,
      );
      expect(url.searchParams.get("labelSelector")).toBe(
        "homelab-dashboard.io/discover=true",
      );
      expect(url.searchParams.get("limit")).toBe("100");
      expect(options).toMatchObject({
        method: "GET",
        rejectUnauthorized: true,
        agent: false,
        headers: { Authorization: `Bearer synthetic-token-${index + 1}` },
      });
      expect(Buffer.from(options.ca as Buffer).toString()).toBe("synthetic-ca");
    }
    expect(transport.seen[1].url.searchParams.get("continue")).toBe(
      "next/opaque?value=1",
    );
    expect(new Set(paths)).toEqual(
      new Set([
        "/var/run/secrets/dashboard-discovery/token",
        "/var/run/secrets/dashboard-discovery/ca.crt",
      ]),
    );
    expect(paths).toHaveLength(6);
  });
  it.each([301, 302, 303, 307, 308, 401, 403, 500])(
    "rejects HTTP %i without following redirects or exposing response bodies",
    async (status) => {
      const transport = syntheticTransport([
        { status, body: "synthetic-private-error-value" },
      ]);
      const fetchRoutes = createKubernetesRouteFetcher({
        request: transport.request,
        readFile: async () => "synthetic-value",
      });
      await expect(
        fetchRoutes(["media"], new AbortController().signal),
      ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
      expect(transport.seen).toHaveLength(1);
    },
  );
  it.each([
    { type: "text/html", body: "<html>synthetic</html>" },
    { body: "{" },
    {
      body: JSON.stringify({ apiVersion: "v1", kind: "SecretList", items: [] }),
    },
    { body: list(Array.from({ length: 101 }, () => route())) },
    { body: " ".repeat(MAX_DISCOVERY_BYTES + 1) },
  ])(
    "rejects malformed, wrong-kind or oversized API collections %#",
    async (page) => {
      const transport = syntheticTransport([page]);
      const fetchRoutes = createKubernetesRouteFetcher({
        request: transport.request,
        readFile: async () => "synthetic-value",
      });
      await expect(
        fetchRoutes(["media"], new AbortController().signal),
      ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
    },
  );
  it("bounds repeated and excessive continuation pages", async () => {
    for (const pages of [
      [{ body: list([], "repeat") }, { body: list([], "repeat") }],
      Array.from({ length: 5 }, (_, i) => ({ body: list([], `page-${i}`) })),
    ]) {
      const transport = syntheticTransport(pages);
      const fetchRoutes = createKubernetesRouteFetcher({
        request: transport.request,
        readFile: async () => "synthetic-value",
      });
      await expect(
        fetchRoutes(["media"], new AbortController().signal),
      ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
      expect(transport.seen.length).toBeLessThanOrEqual(5);
    }
  });
  it("never starts a request with an invalid namespace or unsafe token", async () => {
    const transport = syntheticTransport([]);
    const readFile = vi.fn(async () => "synthetic-token\r\nInjected: value");
    const fetchRoutes = createKubernetesRouteFetcher({
      request: transport.request,
      readFile,
    });
    await expect(
      fetchRoutes(["../secrets"], new AbortController().signal),
    ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
    expect(readFile).not.toHaveBeenCalled();
    await expect(
      fetchRoutes(["media"], new AbortController().signal),
    ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
    expect(transport.seen).toEqual([]);
  });
  it("bounds an unresponsive HTTPS request and sanitizes request errors", async () => {
    vi.useFakeTimers();
    const transport = syntheticTransport([{ hang: true }]);
    const fetchRoutes = createKubernetesRouteFetcher({
      request: transport.request,
      readFile: async () => "synthetic-value",
    });
    const pending = expect(
      fetchRoutes(["media"], new AbortController().signal),
    ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    const failed = createKubernetesRouteFetcher({
      request: (() => {
        throw new Error("synthetic-private-credential");
      }) as typeof https.request,
      readFile: async () => "synthetic-value",
    });
    await expect(
      failed(["media"], new AbortController().signal),
    ).rejects.toThrow(/^DISCOVERY_UNAVAILABLE$/);
  });
});
