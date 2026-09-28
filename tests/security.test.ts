import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../server/app.js";
import {
  catalogSchema,
  loadRuntime,
  validateCatalog,
} from "../server/config.js";
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
async function fixture(groups = ["users", "jellyfin"]) {
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
    catalog,
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
