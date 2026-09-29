# Desktop feature direction

The goal is a familiar personal app desktop with cluster-aware, permission-aware
behavior. Umbrel is a useful interaction reference. This project runs alongside
an existing cluster and identity provider, so workload ownership stays with the
cluster's deployment system.

## Implemented in the 0.2.0 source

- Resolve icons dynamically through the selfh.st index, with trusted local
  fallbacks and a per-app local-only option.
- Discover opted-in HTTPRoutes or projected route snapshots and apply explicit
  server-side access policies to apps, search, folders and dock entries.
- Refresh additions/removals automatically, expire stale discovery, and preserve
  saved layouts during source outages.
- Search both authorized apps and actions: desktop settings, wallpaper, folders,
  dock customization and rearranging.
- Retain the existing per-account layouts, wallpaper, folders, dock, keyboard and
  touch controls, weather opt-in, OIDC sign-in and revision-safe persistence.

These are source capabilities pending deployment acceptance. A route appearing in
discovery is not proof of application health or a successful downstream login.

## Next useful increments

| Priority | Feature                                   | Benefit and scope                                                                                                                                                                                                                       |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Administrator Sources panel               | Display the existing read-only sync diagnostics, explain skipped configuration, and preview who a proposed policy would allow before GitOps reconciliation. Any future editing must preserve the single authoritative deployment owner. |
| 2        | Permission-aware app status               | Show checked-at times, explicit unknown/stale states and links to authorized monitoring. Route acceptance and real app health must remain distinct; no general-purpose URL proxy or browser-held API keys.                              |
| 3        | Personal widget picker                    | Let each person enable, hide and order a small set of widgets. Filter both widget listings and data by the same app permissions; start with existing date/weather and authorized status.                                                |
| 4        | Administrator-managed shortcuts           | Support approved internal links with the same URL validation and permission projection; preserve source provenance so a user understands where an app comes from.                                                                       |
| 5        | Change awareness and availability history | Explain newly available or removed apps after a permissions/source change, and show bounded source freshness history without exposing other users' grants.                                                                              |

Access explanations, source freshness, safe behavior during discovery failure and
integration with an existing GitOps owner are particularly useful for this
cluster-oriented dashboard. This is a product direction, not a claim that Umbrel
lacks every one of these capabilities.

## Separate architecture decisions

App installation, upgrades, start/stop controls, storage management, terminal/VM
consoles, file browsing and photos would add privileged backend APIs and new
ownership responsibilities. They require an explicit product scope and a design
for delegation through the existing cluster control plane. They are not enabled
by discovery or by adding desktop action search.

## Reference basis

The comparison uses Umbrel 2.0.0 documentation and source, not assumptions from a
screenshot. Umbrel's desktop search covers app and settings actions; its shared
app model gives members access to the same running application while keeping
lifecycle controls with the owner. Personalization includes widgets and shortcuts.

- [What's new in umbrelOS 2](https://umbrel.com/support/getting-started/whats-new-in-umbrelos-2)
- [Personalizing your Umbrel](https://umbrel.com/support/basics/personalizing-your-umbrel)
- [Sharing your Umbrel with other users](https://umbrel.com/support/basics/sharing-your-umbrel-with-other-users)
- [Umbrel 2.0.0 command sources](https://github.com/getumbrel/umbrel/blob/2.0.0/packages/ui/src/components/cmdk-sources.tsx)
- [Umbrel 2.0.0 widget access checks](https://github.com/getumbrel/umbrel/blob/2.0.0/packages/umbreld/source/modules/widgets/routes.ts)
- [selfh.st icon documentation](https://selfh.st/icons-about/)

No Umbrel source code or artwork is included in this implementation.
