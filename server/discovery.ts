import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { appSchema, policySchema, safeUrl, type CatalogApp } from "./config.js";
import {
  createKubernetesRouteFetcher,
  readBoundedDiscoveryFile,
  MAX_DISCOVERY_BYTES,
  MAX_DISCOVERY_ROUTES,
  type DiscoveryFileReader,
  type RouteFetcher,
} from "./kubernetes-discovery.js";

export interface DiscoveryConfig {
  mode: "kubernetes" | "file";
  namespaces: string[];
  pollSeconds: number;
  maxAgeSeconds: number;
  file?: string;
}
export interface DiscoverySnapshot {
  apps: CatalogApp[];
  state: "ready" | "unavailable" | "stale";
  lastSuccessfulSync: string | null;
  rejectedRoutes: number;
  namespaces: string[];
  refreshIntervalSeconds: number;
}
export interface DiscoveryProvider {
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
  snapshot(): DiscoverySnapshot;
}
export interface DiscoveryDependencies {
  clock?: () => number;
  fetchRoutes?: RouteFetcher;
  readFile?: DiscoveryFileReader;
}

const namespaceSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const configSchema = z
  .object({
    mode: z.enum(["kubernetes", "file"]),
    namespaces: z.array(namespaceSchema).min(1).max(32),
    pollSeconds: z.number().int().min(10).max(300),
    maxAgeSeconds: z.number().int().min(10).max(900),
    file: z.string().optional(),
  })
  .strict()
  .refine(
    (config) => new Set(config.namespaces).size === config.namespaces.length,
  )
  .refine((config) => config.maxAgeSeconds >= config.pollSeconds)
  .refine(
    (config) =>
      config.mode !== "file" || (!!config.file && isAbsolute(config.file)),
  );
const annotationSchema = appSchema
  .pick({
    id: true,
    name: true,
    description: true,
    category: true,
    iconSlug: true,
    iconSource: true,
    iconPath: true,
  })
  .extend({
    access: policySchema,
    hostname: z.string().max(253).optional(),
    path: z.string().max(1024).optional(),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(z.unknown()).max(MAX_DISCOVERY_ROUTES),
  })
  .strict();
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FUTURE_TOLERANCE_MS = 30000;
const REFRESH_TIMEOUT_MS = 15000;

export function loadDiscoveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscoveryConfig | undefined {
  if (!env.DASHBOARD_DISCOVERY_MODE) return undefined;
  const parsed = configSchema.safeParse({
    mode: env.DASHBOARD_DISCOVERY_MODE,
    namespaces: (env.DASHBOARD_DISCOVERY_NAMESPACES ?? "")
      .split(",")
      .map((namespace) => namespace.trim()),
    pollSeconds: Number(env.DASHBOARD_DISCOVERY_INTERVAL_SECONDS ?? 30),
    maxAgeSeconds: Number(env.DASHBOARD_DISCOVERY_MAX_AGE_SECONDS ?? 90),
    ...(env.DASHBOARD_DISCOVERY_FILE
      ? { file: env.DASHBOARD_DISCOVERY_FILE }
      : {}),
  });
  if (!parsed.success)
    throw new Error("Invalid dashboard discovery configuration");
  return parsed.data;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parentIdentity(value: unknown, namespace: string): string | undefined {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !HOSTNAME.test(value.name)
  )
    return;
  const group = value.group ?? "gateway.networking.k8s.io";
  const kind = value.kind ?? "Gateway";
  const parentNamespace = value.namespace ?? namespace;
  if (
    typeof group !== "string" ||
    typeof kind !== "string" ||
    typeof parentNamespace !== "string" ||
    !namespaceSchema.safeParse(parentNamespace).success ||
    (value.sectionName !== undefined &&
      !namespaceSchema.safeParse(value.sectionName).success) ||
    (value.port !== undefined &&
      (!Number.isInteger(value.port) ||
        Number(value.port) < 1 ||
        Number(value.port) > 65535))
  )
    return;
  return JSON.stringify([
    group,
    kind,
    parentNamespace,
    value.name,
    value.sectionName ?? null,
    value.port ?? null,
  ]);
}
function currentConditions(
  status: unknown,
  generation: number,
  declaredParents: unknown,
  namespace: string,
): boolean {
  if (!record(status) || !Array.isArray(status.parents)) return false;
  if (
    !Array.isArray(declaredParents) ||
    !declaredParents.length ||
    declaredParents.length > 32
  )
    return false;
  const declared = new Set(
    declaredParents
      .map((parent) => parentIdentity(parent, namespace))
      .filter((parent) => parent !== undefined),
  );
  return status.parents.some((parent) => {
    if (!record(parent) || !Array.isArray(parent.conditions)) return false;
    const identity = parentIdentity(parent.parentRef, namespace);
    if (!identity || !declared.has(identity)) return false;
    const parentConditions = parent.conditions;
    return ["Accepted", "ResolvedRefs"].every((type) => {
      const conditions = parentConditions.filter(
        (condition: unknown) => record(condition) && condition.type === type,
      );
      return (
        conditions.length === 1 &&
        conditions[0].status === "True" &&
        conditions[0].observedGeneration === generation
      );
    });
  });
}
function routeApp(
  route: unknown,
  namespaces: Set<string>,
): CatalogApp | undefined {
  try {
    if (
      !record(route) ||
      route.apiVersion !== "gateway.networking.k8s.io/v1" ||
      route.kind !== "HTTPRoute" ||
      !record(route.metadata) ||
      typeof route.metadata.namespace !== "string" ||
      !namespaces.has(route.metadata.namespace) ||
      !record(route.metadata.labels) ||
      route.metadata.labels["homelab-dashboard.io/discover"] !== "true" ||
      !record(route.metadata.annotations) ||
      !Number.isSafeInteger(route.metadata.generation) ||
      Number(route.metadata.generation) < 1 ||
      !record(route.spec) ||
      !currentConditions(
        route.status,
        Number(route.metadata.generation),
        route.spec.parentRefs,
        route.metadata.namespace,
      ) ||
      !Array.isArray(route.spec.hostnames) ||
      route.spec.hostnames.length === 0 ||
      route.spec.hostnames.length > 16 ||
      route.spec.hostnames.some(
        (host) =>
          typeof host !== "string" || !HOSTNAME.test(host) || isIP(host) !== 0,
      )
    )
      return;
    const raw = route.metadata.annotations["homelab-dashboard.io/app"];
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return;
    const {
      hostname,
      path = "/",
      ...annotation
    } = annotationSchema.parse(JSON.parse(raw));
    const host =
      hostname ??
      (route.spec.hostnames.length === 1 ? route.spec.hostnames[0] : undefined);
    if (!host || !route.spec.hostnames.includes(host)) return;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\?#\s\u0000-\u001f\u007f]/.test(path)
    )
      return;
    const decoded = decodeURIComponent(path);
    if (
      /[\\\u0000-\u001f\u007f]/.test(decoded) ||
      decoded.split("/").some((segment) => segment === "." || segment === "..")
    )
      return;
    const url = safeUrl(`https://${host}${path}`);
    if (url.hostname !== host || url.origin !== `https://${host}`) return;
    return appSchema.parse({ ...annotation, href: url.href });
  } catch {
    return;
  }
}

export function createDiscovery(
  input: DiscoveryConfig,
  dependencies: DiscoveryDependencies = {},
): DiscoveryProvider {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Invalid dashboard discovery configuration");
  const config = parsed.data;
  const namespaces = new Set(config.namespaces);
  const clock = dependencies.clock ?? Date.now;
  const fetchRoutes =
    dependencies.fetchRoutes ?? createKubernetesRouteFetcher();
  const readFile = dependencies.readFile ?? readBoundedDiscoveryFile;
  let apps: CatalogApp[] = [];
  let state: DiscoverySnapshot["state"] = "unavailable";
  let lastSuccessfulSync: string | null = null;
  let synchronizedAt: number | undefined;
  let sourceGeneratedAt: number | undefined;
  let rejectedRoutes = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let generation = 0;

  function clear(next: "unavailable" | "stale") {
    apps = [];
    rejectedRoutes = 0;
    state = next;
  }
  async function synchronize(signal: AbortSignal, lease: number) {
    let items: unknown[];
    let generated: number | undefined;
    if (config.mode === "file") {
      const raw = await readFile(config.file!, signal);
      if (Buffer.byteLength(raw) > MAX_DISCOVERY_BYTES)
        throw new Error("DISCOVERY_UNAVAILABLE");
      const envelope = fileSchema.parse(JSON.parse(raw.toString()));
      items = envelope.items;
      generated = Date.parse(envelope.generatedAt);
      if (generated - clock() > FUTURE_TOLERANCE_MS)
        throw new Error("DISCOVERY_UNAVAILABLE");
    } else items = await fetchRoutes(config.namespaces, signal);
    signal.throwIfAborted();
    if (stopped || lease !== generation) return;
    if (
      !Array.isArray(items) ||
      items.length > MAX_DISCOVERY_ROUTES ||
      Buffer.byteLength(JSON.stringify(items)) > MAX_DISCOVERY_BYTES
    )
      throw new Error("DISCOVERY_UNAVAILABLE");
    const now = clock();
    if (
      generated !== undefined &&
      now - generated >= config.maxAgeSeconds * 1000
    ) {
      clear("stale");
      return;
    }
    const candidates = items.flatMap((route) => {
      const app = routeApp(route, namespaces);
      return app ? [app] : [];
    });
    const counts = new Map<string, number>();
    for (const app of candidates)
      counts.set(app.id, (counts.get(app.id) ?? 0) + 1);
    apps = candidates.filter((app) => counts.get(app.id) === 1);
    rejectedRoutes = items.length - apps.length;
    synchronizedAt = now;
    sourceGeneratedAt = generated;
    lastSuccessfulSync = new Date(now).toISOString();
    state = "ready";
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (active) return active;
    const lease = generation;
    const abort = new AbortController();
    controller = abort;
    let deadline: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("DISCOVERY_UNAVAILABLE"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
      deadline = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS);
      deadline.unref();
    });
    active = Promise.race([synchronize(abort.signal, lease), expired])
      .catch(() => {
        if (lease === generation && !stopped) clear("unavailable");
      })
      .finally(() => {
        clearTimeout(deadline);
        controller = undefined;
        active = undefined;
      });
    return active;
  }
  return {
    async start() {
      if (!timer) {
        stopped = false;
        timer = setInterval(() => void refresh(), config.pollSeconds * 1000);
        timer.unref();
      }
      await refresh();
    },
    stop() {
      stopped = true;
      generation++;
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
      clear("unavailable");
    },
    refresh,
    snapshot() {
      const now = clock();
      const expired =
        synchronizedAt !== undefined &&
        (now - synchronizedAt >= config.maxAgeSeconds * 1000 ||
          synchronizedAt - now > FUTURE_TOLERANCE_MS ||
          (sourceGeneratedAt !== undefined &&
            now - sourceGeneratedAt >= config.maxAgeSeconds * 1000));
      if (state === "ready" && expired) clear("stale");
      return {
        apps: structuredClone(apps),
        state,
        lastSuccessfulSync,
        rejectedRoutes,
        namespaces: [...config.namespaces],
        refreshIntervalSeconds: config.pollSeconds,
      };
    },
  };
}
