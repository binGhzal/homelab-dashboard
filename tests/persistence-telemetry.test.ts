import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  PreferencesStore,
  PreferencesConflict,
  defaultPreferences,
  ownerKey,
} from "../server/preferences.js";
import {
  startTelemetry,
  requestSpan,
  endRequestSpan,
} from "../server/telemetry.js";

afterEach(() => vi.restoreAllMocks());
describe("durable per-account desktop preferences", () => {
  it("persists a layout across restart, enforces revisions and filters revoked apps", () => {
    const directory = mkdtempSync(join(tmpdir(), "dashboard-preferences-"));
    const path = join(directory, "preferences.sqlite");
    const owner = ownerKey("https://identity.example.com", "subject-one");
    let store = new PreferencesStore(path);
    try {
      store.put(
        owner,
        {
          ...defaultPreferences(),
          wallpaper: "midnight",
          folders: [
            { id: "watch", name: "Watch", appIds: ["jellyfin", "seerr"] },
          ],
          order: ["folder:watch"],
          dock: ["seerr"],
        },
        0,
        ["jellyfin", "seerr"],
      );
      store.close();
      store = new PreferencesStore(path);
      const recovered = store.get(owner, ["jellyfin", "seerr"]);
      expect(recovered.revision).toBe(1);
      expect(recovered.preferences.wallpaper).toBe("midnight");
      expect(recovered.preferences.folders[0].appIds).toEqual([
        "jellyfin",
        "seerr",
      ]);
      expect(() =>
        store.put(owner, defaultPreferences(), 0, ["jellyfin"]),
      ).toThrow(PreferencesConflict);
      expect(store.get(owner, ["jellyfin"]).preferences).toMatchObject({
        folders: [{ id: "watch", name: "Watch", appIds: ["jellyfin"] }],
        dock: [],
      });
      const otherIssuer = ownerKey(
        "https://other-identity.example.com",
        "subject-one",
      );
      expect(otherIssuer).not.toBe(owner);
      expect(store.get(otherIssuer, ["jellyfin"]).revision).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true });
    }
  });
});
describe("privacy-preserving request telemetry", () => {
  it("is disabled by default and rejects credential-bearing collector URLs", () => {
    expect(startTelemetry({})).toBeUndefined();
    for (const endpoint of [
      "file:///tmp/collector",
      "https://user:password@example.com",
      "https://example.com?token=secret",
    ])
      expect(() =>
        startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }),
      ).toThrow();
  });
  it("only records method, route template and response status, including denied requests", () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const startSpan = vi.fn((_name: string, _options?: unknown) => span);
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    const result = requestSpan("GET", "/api/preferences");
    endRequestSpan(result, 403);
    expect(startSpan).toHaveBeenCalledWith("GET /api/preferences", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "http.route": "/api/preferences",
      },
    });
    expect(span.setAttribute).toHaveBeenCalledExactlyOnceWith(
      "http.response.status_code",
      403,
    );
    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
    requestSpan("untrusted-method", "unmatched");
    expect(startSpan.mock.lastCall?.[0]).toBe("OTHER unmatched");
    endRequestSpan(result, 503);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });
});
