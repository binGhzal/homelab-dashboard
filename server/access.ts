import type { Catalog, CatalogApp, Policy } from "./config.js";
import type { PublicApp } from "../shared/types.js";
export interface Identity {
  sub: string;
  givenName: string | null;
  displayName: string;
  groups: string[];
}
function name(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim() &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : null;
}
export function identityFromClaims(claims: Record<string, unknown>): Identity {
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512)
    throw new Error("Missing subject");
  if (
    !Array.isArray(claims.groups) ||
    claims.groups.length > 200 ||
    claims.groups.some((g) => typeof g !== "string" || g.length > 200)
  )
    throw new Error("Missing or invalid groups claim");
  return {
    sub: claims.sub,
    givenName: name(claims.given_name),
    displayName:
      name(claims.name) ?? name(claims.preferred_username) ?? "Your account",
    groups: claims.groups as string[],
  };
}
export function isAdmin(identity: Identity, catalog: Catalog): boolean {
  return catalog.adminGroups.some((g) => identity.groups.includes(g));
}
export function permits(
  policy: Policy,
  identity: Identity,
  catalog: Catalog,
): boolean {
  return (
    (policy.allowAdmin && isAdmin(identity, catalog)) ||
    policy.anyOf.some(
      (rule) =>
        rule.allOf.length > 0 &&
        rule.allOf.every((g) => identity.groups.includes(g)),
    )
  );
}
export function authorizedApps(
  identity: Identity,
  catalog: Catalog,
): PublicApp[] {
  if (!permits(catalog.access, identity, catalog)) return [];
  return catalog.apps
    .filter((app) => permits(app.access, identity, catalog))
    .map((app) => publicApp(app, isAdmin(identity, catalog)));
}
function publicApp(app: CatalogApp, admin: boolean): PublicApp {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    href: app.href,
    icon: app.icon,
    ...(app.iconPath ? { iconPath: app.iconPath } : {}),
    color: app.color,
    category: app.category,
  };
}
