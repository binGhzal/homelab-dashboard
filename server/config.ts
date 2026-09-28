import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const text = z.string().trim().min(1).max(120);
const group = z.string().trim().min(1).max(200);
export const policySchema = z
  .object({
    allowAdmin: z.boolean().default(false),
    anyOf: z
      .array(z.object({ allOf: z.array(group).min(1).max(20) }).strict())
      .max(30)
      .default([]),
  })
  .strict();

export function safeUrl(value: string, allowHttp = false): URL {
  const url = new URL(value);
  if (
    (!allowHttp && url.protocol !== "https:") ||
    (allowHttp && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      "URL must have an approved scheme and no credentials, query or fragment",
    );
  }
  return url;
}
export const catalogSchema = z
  .object({
    version: z.literal(1),
    title: text.default("Home"),
    weatherEnabled: z.boolean().default(true),
    wallpaper: z
      .string()
      .regex(/^\/wallpapers\/[a-z0-9][a-z0-9._-]*\.(webp|png|jpg)$/)
      .nullable()
      .default("/wallpapers/landscape.webp"),
    adminGroups: z.array(group).max(20).default([]),
    access: policySchema,
    apps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
            name: text,
            description: z.string().max(180).default(""),
            href: z.string().url(),
            icon: z
              .enum([
                "play",
                "tickets",
                "tv",
                "film",
                "search",
                "subtitles",
                "list",
                "download",
                "settings",
                "chart",
                "users",
                "link",
              ])
              .default("link"),
            iconPath: z
              .string()
              .regex(/^\/icons\/[a-z0-9][a-z0-9._-]*\.(svg|png|webp)$/)
              .optional(),
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .default("#268ca2"),
            category: text.default("Apps"),
            access: policySchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogApp = Catalog["apps"][number];
export type Policy = z.infer<typeof policySchema>;
export interface Runtime {
  demo: boolean;
  host: string;
  port: number;
  origin: string;
  cookieSecret: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  sessionTtlSeconds: number;
  claimsRefreshSeconds: number;
}
export function validateCatalog(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Catalog {
  const catalog = catalogSchema.parse(input);
  const ids = new Set<string>();
  for (const app of catalog.apps) {
    if (ids.has(app.id)) throw new Error("App IDs must be unique");
    ids.add(app.id);
    safeUrl(app.href);
  }
  return catalog;
}
export function loadCatalog(path: string, env = process.env): Catalog {
  const contents = readFileSync(path, "utf8");
  if (Buffer.byteLength(contents) > 128 * 1024)
    throw new Error("Catalogue is too large");
  return validateCatalog(
    parse(contents, { maxAliasCount: 0, uniqueKeys: true }),
    env,
  );
}
export function loadRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  if (env.DASHBOARD_DEMO && !["true", "false"].includes(env.DASHBOARD_DEMO))
    throw new Error("DASHBOARD_DEMO must be true or false");
  const demo = env.DASHBOARD_DEMO === "true";
  const origin = env.PUBLIC_ORIGIN ?? (demo ? "http://127.0.0.1:3000" : "");
  const url = safeUrl(origin, demo);
  if (origin !== url.origin)
    throw new Error("PUBLIC_ORIGIN must be a bare origin");
  const host = env.HOST ?? (demo ? "127.0.0.1" : "0.0.0.0");
  if (demo && (host !== "127.0.0.1" || url.hostname !== "127.0.0.1"))
    throw new Error("Demo mode is restricted to 127.0.0.1");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid port");
  const cookieSecret =
    env.SESSION_SECRET ??
    (demo ? "local-demo-session-key-not-for-production" : "");
  if (cookieSecret.length < 32 || cookieSecret.length > 4096)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const issuer = env.OIDC_ISSUER ?? "";
  const clientId = env.OIDC_CLIENT_ID ?? "";
  const clientSecret = env.OIDC_CLIENT_SECRET ?? "";
  if (!demo) {
    safeUrl(issuer);
    if (!clientId || !clientSecret)
      throw new Error("OIDC client credentials are required");
  }
  return {
    demo,
    host,
    port,
    origin,
    cookieSecret,
    issuer,
    clientId,
    clientSecret,
    sessionTtlSeconds: 3600,
    claimsRefreshSeconds: 60,
  };
}
