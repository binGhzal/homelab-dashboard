import type { PublicApp } from "../shared/types";
import { brandIcons } from "./brand-icons";

export const SELFHOSTED_ICONS_BASE =
  "https://cdn.jsdelivr.net/gh/selfhst/icons@main/";
export const SELFHOSTED_ICONS_INDEX = `${SELFHOSTED_ICONS_BASE}index.json`;
export const ICON_INDEX_TIMEOUT_MS = 5_000;
export const ICON_INDEX_RETRY_MS = 60_000;
export const ICON_INDEX_MAX_BYTES = 2 * 1024 * 1024;

interface CatalogIcon {
  reference: string;
  format: "svg" | "webp" | "png";
}

export interface IconCatalog {
  references: ReadonlyMap<string, CatalogIcon>;
  names: ReadonlyMap<string, CatalogIcon>;
}

type ArtworkApp = Pick<
  PublicApp,
  "id" | "name" | "iconPath" | "iconSlug" | "iconSource"
>;

function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Read only the published index fields needed to select an existing asset. */
export function parseIconCatalog(value: unknown): IconCatalog {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("Invalid icon index");
  }
  const references = new Map<string, CatalogIcon>();
  const names = new Map<string, CatalogIcon>();
  const ambiguousNames = new Set<string>();
  const seenReferences = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.Name !== "string" ||
      !entry.Name.trim() ||
      entry.Name.length > 200 ||
      typeof entry.Reference !== "string" ||
      entry.Reference.length > 100 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.Reference) ||
      ![entry.SVG, entry.PNG, entry.WebP].every(
        (flag) => flag === "Yes" || flag === "No",
      ) ||
      seenReferences.has(entry.Reference)
    ) {
      throw new Error("Invalid icon index entry");
    }
    seenReferences.add(entry.Reference);
    const format =
      entry.SVG === "Yes"
        ? "svg"
        : entry.WebP === "Yes"
          ? "webp"
          : entry.PNG === "Yes"
            ? "png"
            : undefined;
    if (!format) continue;
    const icon: CatalogIcon = { reference: entry.Reference, format };
    references.set(icon.reference, icon);
    const name = normalizedName(entry.Name);
    if (!name || ambiguousNames.has(name)) continue;
    if (names.has(name)) {
      names.delete(name);
      ambiguousNames.add(name);
    } else names.set(name, icon);
  }
  return { references, names };
}

/** Never construct a remote path until the official index confirms it exists. */
export function iconSources(
  app: ArtworkApp,
  catalog: IconCatalog | null,
): string[] {
  const sources: string[] = [];
  if (app.iconSource !== "local" && catalog) {
    const icon = app.iconSlug
      ? catalog.references.get(app.iconSlug)
      : (catalog.references.get(app.id) ??
        catalog.names.get(normalizedName(app.name)));
    if (icon) {
      sources.push(
        `${SELFHOSTED_ICONS_BASE}${icon.format}/${icon.reference}.${icon.format}`,
      );
    }
  }
  if (
    app.iconPath &&
    /^\/icons\/[a-z0-9][a-z0-9._-]*\.(svg|png|webp)$/.test(app.iconPath)
  ) {
    sources.push(app.iconPath);
  }
  const bundled = brandIcons[app.id]?.src;
  if (bundled) sources.push(bundled);
  return [...new Set(sources)];
}

async function readBoundedIndex(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Icon index unavailable");
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > ICON_INDEX_MAX_BYTES
  ) {
    void response.body.cancel().catch(() => {});
    throw new Error("Icon index too large");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    if (signal.aborted) throw new Error("Icon index request aborted");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ICON_INDEX_MAX_BYTES) throw new Error("Icon index too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A page-wide cache also coalesces requests from desktop, dock and folder tiles. */
export function createIconCatalogLoader(
  fetcher: typeof fetch = (...args) => fetch(...args),
) {
  let catalog: IconCatalog | null = null;
  let inFlight: Promise<IconCatalog | null> | null = null;
  let retryAfter = 0;
  return {
    peek: () => catalog,
    load(): Promise<IconCatalog | null> {
      if (catalog) return Promise.resolve(catalog);
      if (inFlight) return inFlight;
      if (Date.now() < retryAfter) return Promise.resolve(null);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Icon index timed out"));
        }, ICON_INDEX_TIMEOUT_MS);
      });
      const request = Promise.resolve()
        .then(() =>
          fetcher(SELFHOSTED_ICONS_INDEX, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            mode: "cors",
            redirect: "error",
            signal: controller.signal,
          }),
        )
        .then((response) => readBoundedIndex(response, controller.signal))
        .then(parseIconCatalog);
      inFlight = Promise.race([request, timeout])
        .then((result) => {
          catalog = result;
          return catalog;
        })
        .catch(() => {
          controller.abort();
          retryAfter = Date.now() + ICON_INDEX_RETRY_MS;
          return null;
        })
        .finally(() => {
          clearTimeout(timer);
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export const iconCatalogLoader = createIconCatalogLoader();
