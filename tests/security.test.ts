import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../server/app.js";
import {
  catalogSchema,
  loadRuntime,
  validateCatalog,
  type Catalog,
} from "../server/config.js";
import type {
  DiscoveryProvider,
  DiscoverySnapshot,
} from "../server/discovery.js";
import {
  authorizedApps,
  identityFromClaims,
  permits,
} from "../server/access.js";
import { ExpiringStore } from "../server/sessions.js";
import {
  PreferencesStore,
  defaultPreferences,
  ownerKey,
  PreferencesConflict,
} from "../server/preferences.js";
import type { IdentityProvider } from "../server/oidc.js";
const runtime = loadRuntime({
  PUBLIC_ORIGIN: "https://dashboard.example.com",
  SESSION_SECRET: "test-session-secret-only-never-production-123",
  OIDC_ISSUER: "https://auth.example.com/application/o/dashboard/",
  OIDC_CLIENT_ID: "dashboard",
  OIDC_CLIENT_SECRET: "synthetic-client-secret",
});
const catalog = catalogSchema.parse({
  version: 1,
  adminGroups: ["admins"],
  access: { allowAdmin: true, anyOf: [{ allOf: ["users"] }] },
  apps: [
    {
      id: "jellyfin",
      name: "Jellyfin",
      href: "https://jellyfin.example.com",
      access: { allowAdmin: true, anyOf: [{ allOf: ["users", "jellyfin"] }] },
    },
    {
      id: "private",
      name: "Hidden app",
      href: "https://private.example.com",
      access: { allowAdmin: true },
    },
    {
      id: "closed",
      name: "Closed",
      href: "https://closed.example.com",
      access: {},
    },
  ],
});
const host = { host: "dashboard.example.com" };
const instances: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});
async function fixture(
  groups = ["users", "jellyfin"],
  options: { discovery?: DiscoveryProvider; catalog?: Catalog } = {},
) {
  let now = Date.now();
  let claims: Record<string, unknown> = {
    sub: "user-one",
    name: "Alex Fullname",
    given_name: "Alex",
    groups,
  };
  const exchange = vi.fn(async () => ({
    claims,
    accessToken: "synthetic-access-token",
    expiresIn: 900,
  }));
  const userinfo = vi.fn(async () => claims);
  const provider: IdentityProvider = {
    async login(attempt) {
      const url = new URL("https://auth.example.com/authorize");
      url.searchParams.set("state", attempt.state);
      return url.href;
    },
    exchange,
    userinfo,
  };
  const app = await createApp({
    catalog: options.catalog ?? catalog,
    discovery: options.discovery,
    runtime,
    provider,
    staticRoot: false,
    clock: () => now,
  });
  instances.push(app);
  async function login() {
    const start = await app.inject({ url: "/auth/login", headers: host });
    const attempt = start.cookies.find(
      (c) => c.name === "__Host-dashboard-login",
    )!;
    const state = new URL(start.headers.location!).searchParams.get("state");
    const result = await app.inject({
      url: `/auth/callback?code=synthetic&state=${state}`,
      headers: { ...host, cookie: `${attempt.name}=${attempt.value}` },
    });
    const session = result.cookies.find((c) => c.name === "__Host-dashboard")!;
    return {
      result,
      cookie: session ? `${session.name}=${session.value}` : "",
      attempt,
      state,
    };
  }
  return {
    app,
    login,
    exchange,
    userinfo,
    advance: (ms: number) => {
      now += ms;
    },
    setClaims: (value: Record<string, unknown>) => {
      claims = value;
    },
  };
}
describe("server-side identity and entitlements", () => {
  it("denies anonymous catalogue, search and preferences access", async () => {
    const { app } = await fixture();
    for (const url of [
      "/api/user",
      "/api/apps",
      "/api/search?q=private",
      "/api/preferences",
    ])
      expect((await app.inject({ url, headers: host })).statusCode).toBe(401);
  });
  it("never returns unauthorized app names or URLs, including search and layout metadata", async () => {
    const { app, login } = await fixture();
    const { cookie } = await login();
    const headers = { ...host, cookie };
    const response = await app.inject({ url: "/api/apps", headers });
    expect(response.json().apps.map((a: { id: string }) => a.id)).toEqual([
      "jellyfin",
    ]);
    expect(response.body).not.toContain("private");
    expect(
      (await app.inject({ url: "/api/search?q=Hidden", headers })).json(),
    ).toEqual({ apps: [] });
    expect(
      (await app.inject({ url: "/api/preferences", headers })).body,
    ).not.toContain("private");
  });
  it("requires every group and denies empty rules even for admins", () => {
    expect(
      permits(
        catalog.apps[0].access,
        identityFromClaims({ sub: "u", groups: ["jellyfin"] }),
        catalog,
      ),
    ).toBe(false);
    expect(
      permits(
        catalog.apps[2].access,
        identityFromClaims({ sub: "a", groups: ["admins"] }),
        catalog,
      ),
    ).toBe(false);
  });
  it("refreshes group membership and fails closed on identity outage", async () => {
    const f = await fixture(["admins"]);
    const { cookie } = await f.login();
    f.setClaims({ sub: "user-one", given_name: "Alex", groups: ["users"] });
    f.advance(61000);
    expect(
      (
        await f.app.inject({ url: "/api/apps", headers: { ...host, cookie } })
      ).json(),
    ).toEqual({ apps: [] });
    expect(f.userinfo).toHaveBeenCalledTimes(1);
    f.userinfo.mockRejectedValueOnce(new Error("Provider offline"));
    f.advance(61000);
    expect(
      (await f.app.inject({ url: "/api/apps", headers: { ...host, cookie } }))
        .statusCode,
    ).toBe(401);
  });
  it("rejects subject changes and never merges groups across users", async () => {
    const f = await fixture();
    const { cookie } = await f.login();
    f.setClaims({ sub: "user-two", groups: ["admins"] });
    f.advance(61000);
    expect(
      (await f.app.inject({ url: "/api/apps", headers: { ...host, cookie } }))
        .statusCode,
    ).toBe(401);
    for (const groups of [["users"], ["jellyfin"]])
      expect(
        authorizedApps(identityFromClaims({ sub: "u", groups }), catalog),
      ).toEqual([]);
  });
  it("uses given_name without guessing from display name and rejects malformed groups", () => {
    expect(
      identityFromClaims({ sub: "a", name: "Family Given", groups: [] })
        .givenName,
    ).toBeNull();
    expect(
      identityFromClaims({ sub: "a", given_name: "Given Name", groups: [] })
        .givenName,
    ).toBe("Given Name");
    expect(() => identityFromClaims({ sub: "a", groups: "admins" })).toThrow();
  });
  it("has no widget/HTTP proxy capability, even for an administrator", async () => {
    const f = await fixture(["admins"]);
    const { cookie } = await f.login();
    expect(
      (
        await f.app.inject({
          url: "/api/widgets/jellyfin?url=http://169.254.169.254/",
          headers: { ...host, cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          url: "/api/proxy?url=http://127.0.0.1/",
          headers: { ...host, cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});
describe("login, cookies and CSRF", () => {
  it("preserves rate-limit and malformed-body status without leaking errors; health probes remain available", async () => {
    const { app } = await fixture();
    for (let i = 0; i < 20; i++)
      expect(
        (await app.inject({ url: "/auth/login", headers: host })).statusCode,
      ).toBe(302);
    const limited = await app.inject({ url: "/auth/login", headers: host });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "Request could not be completed" });
    const malformed = await app.inject({
      method: "PUT",
      url: "/api/preferences",
      headers: { ...host, "content-type": "application/json" },
      payload: "{private-malformed-content",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("private-malformed-content");
    for (let i = 0; i < 305; i++)
      await app.inject({ url: "/api/user", headers: host });
    expect(
      (await app.inject({ url: "/api/user", headers: host })).statusCode,
    ).toBe(429);
    for (let i = 0; i < 305; i++)
      expect(
        (await app.inject({ url: "/healthz", headers: host })).statusCode,
      ).toBe(200);
  });
  it("rejects mismatched state before exchange", async () => {
    const f = await fixture();
    const response = await f.app.inject({ url: "/auth/login", headers: host });
    const cookie = response.cookies[0];
    expect(
      (
        await f.app.inject({
          url: "/auth/callback?code=x&state=wrong",
          headers: { ...host, cookie: `${cookie.name}=${cookie.value}` },
        })
      ).headers.location,
    ).toBe("/?auth=failed");
    expect(f.exchange).not.toHaveBeenCalled();
  });
  it("uses secure host-only HTTP-only cookies and rejects callback replay", async () => {
    const f = await fixture();
    const { result, attempt, state } = await f.login();
    const cookie = result.cookies.find((c) => c.name === "__Host-dashboard")!;
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
    expect(cookie.domain).toBeUndefined();
    expect(
      (
        await f.app.inject({
          url: `/auth/callback?code=x&state=${state}`,
          headers: { ...host, cookie: `${attempt.name}=${attempt.value}` },
        })
      ).headers.location,
    ).toBe("/?auth=failed");
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("requires same-origin and CSRF for logout, then invalidates the session", async () => {
    const f = await fixture();
    const { cookie } = await f.login();
    const headers = { ...host, cookie };
    const user = (await f.app.inject({ url: "/api/user", headers })).json();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { ...headers, origin: runtime.origin },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: {
            ...headers,
            origin: "https://evil.example",
            "x-csrf-token": user.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: {
            ...headers,
            origin: runtime.origin,
            "x-csrf-token": user.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: "/api/user", headers })).statusCode).toBe(
      401,
    );
  });
  it("rejects forged cookies, expired tokens and unexpected Host/Origin", async () => {
    const f = await fixture();
    const { cookie } = await f.login();
    expect(
      (
        await f.app.inject({
          url: "/api/apps",
          headers: { ...host, cookie: cookie + "forged" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          url: "/auth/login",
          headers: {
            host: "evil.example",
            "x-forwarded-host": "dashboard.example.com",
          },
        })
      ).statusCode,
    ).toBe(421);
    expect(
      (
        await f.app.inject({
          url: "/api/user",
          headers: { ...host, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    f.advance(901000);
    expect(
      (await f.app.inject({ url: "/api/apps", headers: { ...host, cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          url: "/healthz",
          headers: { host: "probe.internal" },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("bounds session memory and expires old entries", () => {
    let now = 0;
    const store = new ExpiringStore<{ expiresAt: number }>(1, () => now);
    const id = store.set({ expiresAt: 10 });
    expect(() => store.set({ expiresAt: 20 })).toThrow();
    now = 11;
    expect(store.get(id)).toBeUndefined();
    expect(store.set({ expiresAt: 20 })).toBeTruthy();
  });
});
describe("per-user durable preferences", () => {
  it("isolates users and strips unauthorized IDs from folders, order and dock", () => {
    const store = new PreferencesStore(":memory:");
    const one = ownerKey("issuer", "one");
    const two = ownerKey("issuer", "two");
    const value = {
      ...defaultPreferences(),
      order: ["private", "jellyfin"],
      dock: ["private", "jellyfin"],
      folders: [
        { id: "f-one", name: "Media", appIds: ["private", "jellyfin"] },
      ],
    };
    const saved = store.put(one, value, 0, ["jellyfin"]);
    expect(JSON.stringify(saved)).not.toContain("private");
    expect(store.get(two, ["jellyfin"]).revision).toBe(0);
    expect(store.get(two, ["jellyfin"]).preferences.folders).toEqual([]);
    expect(store.get(one, []).preferences.folders).toEqual([]);
    expect(store.get(one, []).preferences.dock).toEqual([]);
    store.close();
  });
  it("rejects stale revisions instead of overwriting another browser", () => {
    const store = new PreferencesStore(":memory:");
    store.put("user", defaultPreferences(), 0, []);
    expect(() => store.put("user", defaultPreferences(), 0, [])).toThrow(
      PreferencesConflict,
    );
    expect(store.get("user", []).revision).toBe(1);
    store.close();
  });
  it("guards preference writes with CSRF and ignores caller-supplied owner IDs", async () => {
    const f = await fixture();
    const { cookie } = await f.login();
    const headers = { ...host, cookie };
    const user = (await f.app.inject({ url: "/api/user", headers })).json();
    const body = { revision: 0, preferences: defaultPreferences() };
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: { ...headers, origin: runtime.origin },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const authorized = {
      ...headers,
      origin: runtime.origin,
      "x-csrf-token": user.csrfToken,
    };
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: authorized,
          payload: { ...body, owner: "other-user" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: authorized,
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers: authorized,
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
  });
});
describe("configuration", () => {
  it("rejects non-loopback demo and absent production credentials", () => {
    expect(() =>
      loadRuntime({ DASHBOARD_DEMO: "true", HOST: "0.0.0.0" }),
    ).toThrow();
    expect(() =>
      loadRuntime({
        DASHBOARD_DEMO: "true",
        PUBLIC_ORIGIN: "http://demo.example",
      }),
    ).toThrow();
    expect(() =>
      loadRuntime({ PUBLIC_ORIGIN: "https://dashboard.example.com" }),
    ).toThrow();
  });
  it("accepts no app API credentials, unsafe links or remote icon paths", () => {
    expect(() => validateCatalog(catalog)).not.toThrow();
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://example.com",
      "https://user:pass@example.com",
    ])
      expect(() =>
        validateCatalog({ ...catalog, apps: [{ ...catalog.apps[0], href }] }),
      ).toThrow();
    for (const iconPath of [
      "https://evil.example/icon.svg",
      "/icons/../secrets",
      "/api/user",
      "/icons/a.svg?secret=foo",
    ])
      expect(() =>
        validateCatalog({
          ...catalog,
          apps: [{ ...catalog.apps[0], iconPath }],
        }),
      ).toThrow();
    expect(() =>
      validateCatalog({
        ...catalog,
        apps: [{ ...catalog.apps[0], widget: { apiKeyEnv: "SECRET" } }],
      }),
    ).toThrow();
  });
});

describe("permission-aware discovery integration", () => {
  function source() {
    let value: DiscoverySnapshot = {
      state: "ready",
      apps: catalogSchema.parse({
        ...catalog,
        apps: [
          {
            id: "photos",
            name: "Family photos",
            href: "https://photos.example.com",
            iconSlug: "immich",
            access: { anyOf: [{ allOf: ["users", "photos"] }] },
          },
          {
            id: "discovered-secret",
            name: "Restricted service",
            href: "https://restricted.example.com",
            access: { allowAdmin: true },
          },
        ],
      }).apps,
      lastSuccessfulSync: new Date().toISOString(),
      rejectedRoutes: 1,
      namespaces: ["media"],
      refreshIntervalSeconds: 30,
    };
    const provider: DiscoveryProvider = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      refresh: vi.fn(async () => {}),
      snapshot: vi.fn(() => structuredClone(value)),
    };
    return {
      provider,
      set: (updates: Partial<DiscoverySnapshot>) => {
        value = { ...value, ...updates };
      },
    };
  }
  it("filters discovered apps, search and layouts without disclosing policies or other apps", async () => {
    const discovery = source();
    const f = await fixture(["users", "photos"], {
      discovery: discovery.provider,
    });
    const { cookie } = await f.login();
    const headers = { ...host, cookie };
    const apps = await f.app.inject({ url: "/api/apps", headers });
    expect(apps.json().apps.map((app: { id: string }) => app.id)).toEqual([
      "photos",
    ]);
    expect(apps.json().apps[0].iconSlug).toBe("immich");
    for (const secret of [
      "discovered-secret",
      "restricted.example.com",
      "allowAdmin",
      "anyOf",
    ])
      expect(apps.body).not.toContain(secret);
    expect(
      (await f.app.inject({ url: "/api/search?q=Restricted", headers })).json(),
    ).toEqual({ apps: [] });
    const preferences = await f.app.inject({
      url: "/api/preferences",
      headers,
    });
    expect(preferences.json().preferences.order).toEqual(["photos"]);
    const csrf = (await f.app.inject({ url: "/api/user", headers })).json()
      .csrfToken;
    const saved = await f.app.inject({
      method: "PUT",
      url: "/api/preferences",
      headers: { ...headers, origin: runtime.origin, "x-csrf-token": csrf },
      payload: {
        revision: 0,
        catalogRevision: preferences.json().catalogRevision,
        preferences: {
          ...defaultPreferences(),
          order: ["photos", "discovered-secret"],
          dock: ["discovered-secret", "photos"],
          folders: [
            {
              id: "favorites",
              name: "Favorites",
              appIds: ["photos", "discovered-secret"],
            },
          ],
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("discovered-secret");
  });
  it("removes disappeared apps immediately and refreshes revoked group membership", async () => {
    const discovery = source();
    const f = await fixture(["users", "photos"], {
      discovery: discovery.provider,
    });
    const { cookie } = await f.login();
    const headers = { ...host, cookie };
    expect(
      (await f.app.inject({ url: "/api/apps", headers })).json().apps,
    ).toHaveLength(1);
    f.setClaims({ sub: "user-one", groups: ["users"] });
    f.advance(61000);
    expect(
      (await f.app.inject({ url: "/api/apps", headers })).json().apps,
    ).toEqual([]);
    f.setClaims({ sub: "user-one", groups: ["users", "photos"] });
    f.advance(61000);
    expect(
      (await f.app.inject({ url: "/api/apps", headers })).json().apps,
    ).toHaveLength(1);
    discovery.set({ apps: [] });
    expect(
      (await f.app.inject({ url: "/api/apps", headers })).json().apps,
    ).toEqual([]);
    expect(
      (await f.app.inject({ url: "/api/preferences", headers })).json()
        .preferences.order,
    ).toEqual([]);
  });
  it("keeps static policy authoritative for collisions and cannot grant dashboard admission", async () => {
    const discovery = source();
    discovery.set({
      apps: [
        {
          ...catalog.apps[0],
          name: "Spoofed app",
          href: "https://untrusted.example.com",
          access: { allowAdmin: false, anyOf: [{ allOf: ["users"] }] },
        },
      ],
    });
    const f = await fixture(["users"], { discovery: discovery.provider });
    const { cookie } = await f.login();
    expect(
      (
        await f.app.inject({ url: "/api/apps", headers: { ...host, cookie } })
      ).json().apps,
    ).toEqual([]);
    const outside = await fixture(["photos"], { discovery: source().provider });
    expect((await outside.login()).cookie).toBe("");
  });
  it.each(["unavailable", "stale"] as const)(
    "protects saved dynamic layouts during %s discovery and restores them on recovery",
    async (state) => {
      const discovery = source();
      const f = await fixture(["users", "photos", "jellyfin"], {
        discovery: discovery.provider,
      });
      const { cookie } = await f.login();
      const headers = { ...host, cookie };
      const csrf = (await f.app.inject({ url: "/api/user", headers })).json()
        .csrfToken;
      const writeHeaders = {
        ...headers,
        origin: runtime.origin,
        "x-csrf-token": csrf,
      };
      const original = (
        await f.app.inject({ url: "/api/preferences", headers })
      ).json();
      const saved = await f.app.inject({
        method: "PUT",
        url: "/api/preferences",
        headers: writeHeaders,
        payload: {
          revision: 0,
          catalogRevision: original.catalogRevision,
          preferences: {
            ...defaultPreferences(),
            dock: ["photos"],
            folders: [
              { id: "favorites", name: "Favorites", appIds: ["photos"] },
            ],
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      discovery.set({ state });
      expect(
        (await f.app.inject({ url: "/api/apps", headers }))
          .json()
          .apps.map((app: { id: string }) => app.id),
      ).toEqual(["jellyfin"]);
      const during = (
        await f.app.inject({ url: "/api/preferences", headers })
      ).json();
      expect(during.preferences.folders).toEqual([]);
      expect(
        (
          await f.app.inject({
            method: "PUT",
            url: "/api/preferences",
            headers: writeHeaders,
            payload: during,
          })
        ).statusCode,
      ).toBe(503);
      discovery.set({ state: "ready" });
      // A draft loaded during the outage must not erase recovered entries.
      expect(
        (
          await f.app.inject({
            method: "PUT",
            url: "/api/preferences",
            headers: writeHeaders,
            payload: during,
          })
        ).statusCode,
      ).toBe(409);
      const recovered = (
        await f.app.inject({ url: "/api/preferences", headers })
      ).json();
      expect(recovered.revision).toBe(1);
      expect(recovered.preferences.dock).toEqual(["photos"]);
      expect(recovered.preferences.folders[0].appIds).toEqual(["photos"]);
      expect(
        (
          await f.app.inject({
            method: "PUT",
            url: "/api/preferences",
            headers: writeHeaders,
            payload: recovered,
          })
        ).statusCode,
      ).toBe(200);
    },
  );
  it("restricts safe discovery diagnostics to administrators", async () => {
    const discovery = source();
    for (const groups of [["users"], ["admins"]]) {
      const f = await fixture(groups, { discovery: discovery.provider });
      expect(
        (await f.app.inject({ url: "/api/discovery", headers: host }))
          .statusCode,
      ).toBe(401);
      const { cookie } = await f.login();
      const response = await f.app.inject({
        url: "/api/discovery",
        headers: { ...host, cookie },
      });
      expect(response.statusCode).toBe(groups.includes("admins") ? 200 : 403);
      if (response.statusCode === 200) {
        expect(response.json()).toMatchObject({
          state: "ready",
          discoveredApps: 2,
          rejectedRoutes: 1,
          namespaces: ["media"],
        });
        for (const secret of [
          "photos",
          "restricted.example.com",
          "access",
          "anyOf",
        ])
          expect(response.body).not.toContain(secret);
      }
    }
  });
  it("fails the dynamic source closed if the combined catalog exceeds the layout capacity", async () => {
    const discovery = source();
    discovery.set({
      apps: Array.from({ length: 100 }, (_, index) => ({
        ...catalog.apps[0],
        id: `app-${index}`,
      })),
    });
    const f = await fixture(["admins"], { discovery: discovery.provider });
    const { cookie } = await f.login();
    const headers = { ...host, cookie };
    expect(
      (await f.app.inject({ url: "/api/apps", headers }))
        .json()
        .apps.map((app: { id: string }) => app.id),
    ).toEqual(["jellyfin", "private"]);
    expect(
      (await f.app.inject({ url: "/api/discovery", headers })).json(),
    ).toMatchObject({ state: "unavailable", discoveredApps: 0 });
  });
});
