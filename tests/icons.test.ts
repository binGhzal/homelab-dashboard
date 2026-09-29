import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIconCatalogLoader,
  iconSources,
  ICON_INDEX_MAX_BYTES,
  ICON_INDEX_RETRY_MS,
  ICON_INDEX_TIMEOUT_MS,
  parseIconCatalog,
  SELFHOSTED_ICONS_BASE,
  SELFHOSTED_ICONS_INDEX,
} from "../src/icon-catalog";

const entry = (Reference = "jellyfin", Name = "Jellyfin") => ({
  Name,
  Reference,
  SVG: "Yes",
  PNG: "Yes",
  WebP: "Yes",
});
const app = { id: "jellyfin", name: "Jellyfin" };
const remote = (path: string) => `${SELFHOSTED_ICONS_BASE}${path}`;
const response = (value: unknown = [entry()]) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.useRealTimers());

describe("verified selfh.st icon resolution", () => {
  it("selects original SVG, then WebP, then PNG using published availability", () => {
    const catalog = parseIconCatalog([
      { ...entry(), Light: "Yes", Dark: "Yes" },
      { ...entry("decypharr", "Decypharr"), SVG: "No" },
      { ...entry("bitmap", "Bitmap"), SVG: "No", WebP: "No" },
    ]);
    expect(iconSources(app, catalog)).toEqual([
      remote("svg/jellyfin.svg"),
      "/icons/jellyfin.svg",
    ]);
    expect(
      iconSources({ id: "decypharr", name: "Decypharr" }, catalog),
    ).toEqual([remote("webp/decypharr.webp"), "/icons/decypharr.png"]);
    expect(iconSources({ id: "bitmap", name: "Bitmap" }, catalog)).toEqual([
      remote("png/bitmap.png"),
    ]);
  });

  it("uses an explicit slug before ID and normalized official name matches", () => {
    const catalog = parseIconCatalog([
      entry(),
      entry("ara-records-ansible", "ARA"),
      entry("paperless-ngx", "Paperless-ngx"),
    ]);
    expect(
      iconSources({ ...app, iconSlug: "ara-records-ansible" }, catalog)[0],
    ).toBe(remote("svg/ara-records-ansible.svg"));
    expect(
      iconSources({ id: "custom", name: "  Paperless NGX " }, catalog),
    ).toEqual([remote("svg/paperless-ngx.svg")]);
    expect(iconSources({ id: "custom", name: "ara" }, catalog)).toEqual([
      remote("svg/ara-records-ansible.svg"),
    ]);
    expect(iconSources({ ...app, name: "ARA" }, catalog)[0]).toBe(
      remote("svg/jellyfin.svg"),
    );
  });

  it("does not guess paths, aliases or fall through an unknown explicit slug", () => {
    const catalog = parseIconCatalog([
      entry("home-assistant", "Home Assistant"),
    ]);
    expect(
      iconSources({ id: "homeassistant", name: "My house" }, catalog),
    ).toEqual([]);
    expect(
      iconSources({ ...app, iconSlug: "missing" }, parseIconCatalog([entry()])),
    ).toEqual(["/icons/jellyfin.svg"]);
    expect(iconSources({ id: "new-app", name: "New app" }, catalog)).toEqual(
      [],
    );
  });

  it("keeps ambiguous normalized names unresolved while exact references work", () => {
    const catalog = parseIconCatalog([
      entry("a-one", "A One"),
      entry("a-two", "A-One"),
      entry("a-three", "A One"),
    ]);
    expect(iconSources({ id: "custom", name: "A One" }, catalog)).toEqual([]);
    expect(iconSources({ id: "a-two", name: "A One" }, catalog)).toEqual([
      remote("svg/a-two.svg"),
    ]);
  });

  it("orders local fallbacks, removes duplicates and honors local-only selection", () => {
    const catalog = parseIconCatalog([entry(), entry("grafana", "Grafana")]);
    expect(
      iconSources({ ...app, iconPath: "/icons/custom.png" }, catalog),
    ).toEqual([
      remote("svg/jellyfin.svg"),
      "/icons/custom.png",
      "/icons/jellyfin.svg",
    ]);
    expect(
      iconSources({ ...app, iconPath: "/icons/jellyfin.svg" }, null),
    ).toEqual(["/icons/jellyfin.svg"]);
    expect(iconSources({ ...app, iconSource: "local" }, catalog)).toEqual([
      "/icons/jellyfin.svg",
    ]);
    expect(iconSources({ id: "grafana", name: "Grafana" }, catalog)).toEqual([
      remote("svg/grafana.svg"),
    ]);
    expect(
      iconSources(
        { id: "grafana", name: "Grafana", iconSource: "local" },
        catalog,
      ),
    ).toEqual([]);
  });

  it("rejects malformed metadata, duplicate references and paths outside the CDN", () => {
    for (const value of [
      {},
      [null],
      [entry(), entry()],
      [{ ...entry(), Reference: "../outside" }],
      [{ ...entry(), Reference: "https://example.com/icon" }],
      [{ ...entry(), SVG: "yes" }],
      [{ ...entry(), Name: " " }],
      [{ ...entry(), WebP: undefined }],
      Array.from({ length: 10_001 }, () => entry()),
    ])
      expect(() => parseIconCatalog(value)).toThrow();
    for (const iconPath of [
      "https://example.com/icon.svg",
      "//example.com/icon.svg",
      "/icons/../private.svg",
      "/icons/icon.svg?tracking=1",
    ])
      expect(
        iconSources({ id: "custom", name: "Custom", iconPath }, null),
      ).toEqual([]);
    const catalog = parseIconCatalog([
      { ...entry(), SVG: "No", WebP: "No", PNG: "No" },
    ]);
    expect(iconSources(app, catalog)).toEqual(["/icons/jellyfin.svg"]);
  });
});

describe("shared bounded icon index loader", () => {
  it("coalesces concurrent mounts, caches success and never sends credentials or referrers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const loader = createIconCatalogLoader(fetcher);
    expect(loader.peek()).toBeNull();
    const first = loader.load();
    expect(loader.load()).toBe(first);
    const catalog = await first;
    expect(catalog?.references.has("jellyfin")).toBe(true);
    expect(await loader.load()).toBe(catalog);
    expect(loader.peek()).toBe(catalog);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(SELFHOSTED_ICONS_INDEX, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("falls back on outages, suppresses request storms and permits later retry", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(response());
    const loader = createIconCatalogLoader(fetcher);
    expect(await loader.load()).toBeNull();
    expect(await loader.load()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ICON_INDEX_RETRY_MS);
    expect((await loader.load())?.references.has("jellyfin")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled fetch and aborts it without affecting local fallback", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const loader = createIconCatalogLoader(fetcher);
    const pending = loader.load();
    await vi.advanceTimersByTimeAsync(ICON_INDEX_TIMEOUT_MS);
    expect(await pending).toBeNull();
    const signal = fetcher.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(iconSources(app, loader.peek())).toEqual(["/icons/jellyfin.svg"]);
  });

  it("bounds a stalled response body as well as the initial request", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const pending = createIconCatalogLoader(fetcher).load();
    await vi.advanceTimersByTimeAsync(ICON_INDEX_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await body.cancel().catch(() => {});
  });

  it("rejects HTTP failures, invalid JSON and a schema change gracefully", async () => {
    for (const failedResponse of [
      new Response("Unavailable", { status: 503 }),
      new Response("<html>not json</html>"),
      response({ icons: [entry()] }),
      response([{ ...entry(), SVG: true }]),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(failedResponse);
      expect(await createIconCatalogLoader(fetcher).load()).toBeNull();
    }
  });

  it("enforces the response size bound for declared and streamed bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ICON_INDEX_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    for (const oversized of [
      new Response("[]", {
        headers: { "content-length": String(ICON_INDEX_MAX_BYTES + 1) },
      }),
      new Response(body),
    ]) {
      expect(
        await createIconCatalogLoader(
          vi.fn<typeof fetch>().mockResolvedValue(oversized),
        ).load(),
      ).toBeNull();
    }
    expect(cancel).toHaveBeenCalled();
  });
});
