import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Catalog, Runtime } from "./config.js";
import {
  authorizedApps,
  identityFromClaims,
  isAdmin,
  permits,
  type Identity,
} from "./access.js";
import {
  ExpiringStore,
  matches,
  token,
  type AuthSession,
  type LoginAttempt,
} from "./sessions.js";
import type { IdentityProvider } from "./oidc.js";
import { demoIdentity } from "./demo.js";
import {
  PreferencesStore,
  PreferencesConflict,
  preferencesSchema,
  ownerKey,
} from "./preferences.js";
import { z } from "zod";
import type { User } from "../shared/types.js";
import { requestSpan, endRequestSpan } from "./telemetry.js";
import type { Span } from "@opentelemetry/api";

interface Options {
  catalog: Catalog;
  runtime: Runtime;
  provider?: IdentityProvider;
  env?: NodeJS.ProcessEnv;
  preferences?: PreferencesStore;
  staticRoot?: string | false;
  clock?: () => number;
}
export async function createApp(options: Options) {
  const { catalog, runtime, provider } = options;
  if (!runtime.demo && !provider) throw new Error("Identity provider required");
  const clock = options.clock ?? Date.now;
  const preferences = options.preferences ?? new PreferencesStore(":memory:");
  const sessions = new ExpiringStore<AuthSession>(1000, clock);
  const attempts = new ExpiringStore<LoginAttempt>(300, clock);
  const refreshes = new Map<string, Promise<void>>();
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 65536,
    requestTimeout: 15000,
  });
  const spans = new WeakMap<FastifyRequest, Span>();
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.url !== "/healthz")
      spans.set(
        request,
        requestSpan(request.method, request.routeOptions.url ?? "unmatched"),
      );
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = spans.get(request);
    if (span) {
      endRequestSpan(span, reply.statusCode);
      spans.delete(request);
    }
  });
  const secure = !runtime.demo;
  const sessionCookie = secure ? "__Host-dashboard" : "dashboard-demo";
  const attemptCookie = secure
    ? "__Host-dashboard-login"
    : "dashboard-demo-login";
  const cookieOptions = {
    path: "/",
    secure,
    httpOnly: true,
    sameSite: "lax" as const,
    signed: true,
  };
  await app.register(cookie, { secret: runtime.cookieSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "https://api.open-meteo.com"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: runtime.demo ? null : [],
      },
    },
    hsts: secure ? { maxAge: 31536000 } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    skipOnError: false,
  });
  const gc = setInterval(() => {
    sessions.prune();
    attempts.prune();
  }, 60000);
  gc.unref();
  app.addHook("onClose", async () => {
    clearInterval(gc);
    preferences.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "Permissions-Policy",
      "geolocation=(self), camera=(), microphone=()",
    );
    if (request.url === "/healthz") return;
    if (request.headers.host !== new URL(runtime.origin).host)
      return reply.code(421).send({ error: "Unexpected host" });
    if (request.headers.origin && request.headers.origin !== runtime.origin)
      return reply.code(403).send({ error: "Origin not allowed" });
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/"))
      reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((_error, _request, reply) => {
    // Callback URLs and upstream response bodies may contain secrets; never log them.
    reply.code(500).send({ error: "Request could not be completed" });
  });
  function cookieId(request: FastifyRequest, name: string): string | undefined {
    const raw = request.cookies[name];
    if (!raw) return;
    const value = request.unsignCookie(raw);
    return value.valid ? (value.value ?? undefined) : undefined;
  }
  function clearCookie(reply: FastifyReply, name: string) {
    reply.clearCookie(name, {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  async function authenticated(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ identity: Identity; session?: AuthSession } | undefined> {
    if (runtime.demo) return { identity: demoIdentity };
    const id = cookieId(request, sessionCookie);
    const session = sessions.get(id);
    if (!session || session.tokenExpiresAt <= clock()) {
      if (id) sessions.delete(id);
      clearCookie(reply, sessionCookie);
      reply.code(401).send({ error: "Sign in required" });
      return;
    }
    try {
      if (clock() - session.checkedAt >= runtime.claimsRefreshSeconds * 1000) {
        let refreshing = refreshes.get(id!);
        if (!refreshing) {
          refreshing = provider!
            .userinfo(session.accessToken, session.identity.sub)
            .then((claims) => {
              const identity = identityFromClaims(claims);
              if (identity.sub !== session.identity.sub)
                throw new Error("Subject changed");
              session.identity = identity;
              session.checkedAt = clock();
            })
            .finally(() => refreshes.delete(id!));
          refreshes.set(id!, refreshing);
        }
        await refreshing;
      }
      if (!permits(catalog.access, session.identity, catalog))
        throw new Error("Access revoked");
      return { identity: session.identity, session };
    } catch {
      sessions.delete(id!);
      clearCookie(reply, sessionCookie);
      reply.code(401).send({ error: "Sign in required" });
      return;
    }
  }
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get(
    "/auth/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (runtime.demo) return reply.redirect("/");
      const previous = cookieId(request, attemptCookie);
      attempts.take(previous);
      const attempt = {
        state: token(),
        nonce: token(),
        verifier: token(),
        expiresAt: clock() + 300000,
      };
      const id = attempts.set(attempt);
      try {
        const location = await provider!.login(attempt);
        reply.setCookie(attemptCookie, id, { ...cookieOptions, maxAge: 300 });
        return reply.redirect(location);
      } catch {
        attempts.delete(id);
        return reply
          .code(503)
          .send({ error: "Sign-in service unavailable. Try again shortly." });
      }
    },
  );
  app.get("/auth/callback", async (request, reply) => {
    if (runtime.demo) return reply.code(404).send({ error: "Not found" });
    const attempt = attempts.take(cookieId(request, attemptCookie));
    clearCookie(reply, attemptCookie);
    const callback = new URL(
      request.raw.url ?? "/auth/callback",
      runtime.origin,
    );
    if (
      !attempt ||
      !matches(callback.searchParams.get("state"), attempt.state) ||
      !callback.searchParams.get("code") ||
      callback.searchParams.has("error")
    )
      return reply.redirect("/?auth=failed");
    try {
      const result = await provider!.exchange(callback, attempt);
      const identity = identityFromClaims(result.claims);
      if (!permits(catalog.access, identity, catalog))
        return reply.redirect("/?auth=denied");
      if (!Number.isFinite(result.expiresIn) || result.expiresIn <= 0)
        throw new Error("Expired token");
      const previous = cookieId(request, sessionCookie);
      if (previous) sessions.delete(previous);
      const ttl = Math.min(runtime.sessionTtlSeconds, result.expiresIn);
      const id = sessions.set({
        identity,
        accessToken: result.accessToken,
        tokenExpiresAt: clock() + ttl * 1000,
        csrf: token(),
        expiresAt: clock() + ttl * 1000,
        checkedAt: clock(),
      });
      reply.setCookie(sessionCookie, id, { ...cookieOptions, maxAge: ttl });
      return reply.redirect("/");
    } catch {
      return reply.redirect("/?auth=failed");
    }
  });
  app.post("/auth/logout", async (request, reply) => {
    const auth = await authenticated(request, reply);
    if (!auth) return;
    if (
      request.headers.origin !== runtime.origin ||
      !matches(
        request.headers["x-csrf-token"],
        auth.session?.csrf ?? "demo-csrf",
      )
    )
      return reply.code(403).send({ error: "Request not authorized" });
    const id = cookieId(request, sessionCookie);
    if (id) sessions.delete(id);
    clearCookie(reply, sessionCookie);
    return { signedOut: true };
  });
  app.get("/api/user", async (request, reply): Promise<User | void> => {
    const auth = await authenticated(request, reply);
    if (!auth) return;
    return {
      givenName: auth.identity.givenName,
      displayName: auth.identity.displayName,
      admin: isAdmin(auth.identity, catalog),
      csrfToken: auth.session?.csrf ?? "demo-csrf",
      demo: runtime.demo,
      title: catalog.title,
      wallpaper: catalog.wallpaper,
      weatherEnabled: catalog.weatherEnabled,
    };
  });
  for (const path of ["/api/apps", "/api/search"])
    app.get(path, async (request, reply) => {
      const auth = await authenticated(request, reply);
      if (!auth) return;
      const query =
        new URL(request.raw.url ?? path, runtime.origin).searchParams.get(
          "q",
        ) ?? "";
      if (query.length > 120)
        return reply.code(400).send({ error: "Search is too long" });
      return {
        apps: authorizedApps(auth.identity, catalog).filter((a) =>
          `${a.name} ${a.description} ${a.category}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        ),
      };
    });
  app.get("/api/preferences", async (request, reply) => {
    const auth = await authenticated(request, reply);
    if (!auth) return;
    return preferences.get(
      ownerKey(runtime.issuer, auth.identity.sub),
      authorizedApps(auth.identity, catalog).map((a) => a.id),
    );
  });
  app.put("/api/preferences", async (request, reply) => {
    const auth = await authenticated(request, reply);
    if (!auth) return;
    if (
      request.headers.origin !== runtime.origin ||
      !matches(
        request.headers["x-csrf-token"],
        auth.session?.csrf ?? "demo-csrf",
      )
    )
      return reply.code(403).send({ error: "Request not authorized" });
    const body = z
      .object({
        revision: z.number().int().nonnegative(),
        preferences: preferencesSchema,
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid layout" });
    try {
      return preferences.put(
        ownerKey(runtime.issuer, auth.identity.sub),
        body.data.preferences,
        body.data.revision,
        authorizedApps(auth.identity, catalog).map((a) => a.id),
      );
    } catch (error) {
      if (error instanceof PreferencesConflict)
        return reply.code(409).send({
          error: "Layout changed in another browser. Refresh and try again.",
        });
      throw error;
    }
  });
  const root =
    options.staticRoot === false
      ? false
      : resolve(options.staticRoot ?? "dist/client");
  if (root && existsSync(root)) {
    await app.register(staticFiles, {
      root: resolve(root, "assets"),
      prefix: "/assets/",
      index: false,
      dotfiles: "deny",
      maxAge: "1y",
      immutable: true,
    });
    for (const directory of ["icons", "wallpapers"])
      if (existsSync(resolve(root, directory))) {
        await app.register(staticFiles, {
          root: resolve(root, directory),
          prefix: `/${directory}/`,
          decorateReply: false,
          index: false,
          dotfiles: "deny",
          maxAge: "1h",
        });
      }
    const index = readFileSync(resolve(root, "index.html"), "utf8");
    app.get("/", async (_request, reply) =>
      reply.header("Cache-Control", "no-store").type("text/html").send(index),
    );
  }
  return app;
}
