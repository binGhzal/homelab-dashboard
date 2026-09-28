# Homelab Dashboard

A personal desktop for the applications you are allowed to use. Sign in with
OpenID Connect, open an app, organize your desktop into folders, pin favorites to
the dock, search, and choose a wallpaper. Layouts follow your account across
browsers. Optional weather uses your location only when you ask for it.

The interface and code are independently authored. This is an app launcher, not
an operating system, app installer, cluster administrator, or metrics dashboard.
Use an authorized Grafana launcher for monitoring. It does not need application
API keys, Kubernetes credentials, a Docker socket, or Dapr.

## Try the local demo

Use Node 24 and the exact pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open `http://127.0.0.1:3000`. The clearly labeled demo uses a synthetic account,
application links and sample weather. Clicking a demo app opens a local preview
message. Demo authentication is permitted only on the literal `127.0.0.1`
interface and origin; it cannot be enabled on a public deployment. Demo layouts
are in memory unless `DASHBOARD_DATA_DIR` is explicitly set.

## Production configuration

Mount a catalog based on [config/catalog.example.yaml](config/catalog.example.yaml)
and supply these environment variables through your platform's secret facility:

| Variable                      | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `PUBLIC_ORIGIN`               | Exact external HTTPS origin, without a trailing slash     |
| `OIDC_ISSUER`                 | HTTPS OpenID Connect issuer with discovery metadata       |
| `OIDC_CLIENT_ID`              | Dedicated confidential client identifier                  |
| `OIDC_CLIENT_SECRET`          | Dedicated client credential                               |
| `SESSION_SECRET`              | Random signing secret of at least 32 characters           |
| `DASHBOARD_CONFIG`            | Absolute path to the mounted catalog YAML                 |
| `DASHBOARD_DATA_DIR`          | Writable directory for `preferences.sqlite`, e.g. `/data` |
| `HOST` / `PORT`               | Bind address and port; defaults `0.0.0.0:3000`            |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional trusted OTLP HTTP collector base URL             |

Register precisely `PUBLIC_ORIGIN/auth/callback` as the redirect URI. The client
uses Authorization Code with PKCE S256, state and nonce. `openid`, `profile` and
`email` are requested. The provider's UserInfo response must return a stable
`sub`, a `groups` array of exact group names, and preferably `given_name` and
`name`. For Authentik, configure a profile scope mapping that includes these
claims in UserInfo. The greeting uses `given_name`; it never guesses a first
name by splitting a display name.

Terminate HTTPS at your trusted gateway and preserve the external Host header.
Production cookies are Secure, HttpOnly, SameSite=Lax and `__Host-` scoped. The
application does not trust forwarded identity headers or forwarded client IPs.
Its global request limit therefore applies to the directly connected gateway IP
when deployed behind a proxy; size that limit deliberately before a large
multi-user rollout.

Run `pnpm start` after building, or use the included [Helm chart](chart). Deploy
one replica, a retained 1 GiB volume at `/data`, and a `Recreate` update strategy.
The application supports a read-only root filesystem and an unprivileged UID.
`/healthz` is a bounded process health endpoint; it is not an identity-provider
or downstream application availability check. Startup validates configuration and
OIDC discovery; invalid or unreachable identity configuration fails startup.

The chart is also published to `oci://ghcr.io/binghzal/charts/homelab-dashboard`.
Release CI records its verified OCI manifest digest. Pin that digest in GitOps,
and configure `image.digest` separately to select the tested application image.
For example, download chart version 0.1.0 with:

```sh
helm pull oci://ghcr.io/binghzal/charts/homelab-dashboard --version 0.1.0
```

Published chart versions are never replaced by CI. A repeated release reuses the
existing digest only when every packaged chart file matches; changed chart
contents require a new `Chart.yaml` version. Publication verifies anonymous pulls
by both version and digest. Chart-only changes do not publish another app image.

## Catalog and authorization

Catalog configuration belongs in Git; credentials do not. The YAML is strict and
rejects unknown fields, duplicate application IDs, non-HTTPS application links,
and remote or traversal icon paths. The Helm chart's inline `catalog` value
creates the ConfigMap and rolls the Deployment when it changes. When using
`existingConfigMap` instead, restart the process after changing that mounted
catalog. The browser receives only the authorized projection, never the complete
catalog or access rules.

Both the dashboard's top-level `access` and each app's `access` must allow the
user. Every group in an `allOf` rule is required; any complete rule under `anyOf`
grants access. An empty policy denies access. `adminGroups` does not silently
override this: a particular policy must explicitly set `allowAdmin: true`.

```yaml
access:
  anyOf:
    - allOf: [dashboard-users, app-jellyfin]
```

Authorization is performed on the server for catalog, search and preference
requests. Groups are refreshed from UserInfo after at most 60 seconds on a new
request. Failed refresh, changed subject, expired access token or revoked
**dashboard** access invalidates the session. Revoked app access removes that
app from subsequent responses, folder contents and dock entries. Cached rendered
content in an inactive browser is not remotely erased; the next refresh enforces
the new grants.

Each linked application must independently enforce its own access policy.
Hiding its launcher cannot secure the application's URL. Match dashboard groups
to the gateway or application's real authorization rules.

Application icons can use included SVGs or an operator-provided same-origin
`/icons/<filename>.svg`, `.png` or `.webp`, baked into the image or mounted into
the built client's icons directory. Only install trusted SVG files. `wallpaper`
selects a same-origin asset under `/wallpapers`; users can choose that landscape
or one of two built-in color backgrounds. No remote asset URLs or arbitrary
upstream HTTP proxy are exposed.

## Desktop, privacy and recovery

Drag app tiles to reorder them or drop one into a folder. Each tile's options
also provides movement controls suitable for keyboard and touch. Settings
supports folder creation, wallpaper selection and editing mode. The dock holds
up to eight apps. Search opens with its button or `Ctrl/Cmd + K`. Folders can be
renamed or dissolved without removing their apps.

Preferences contain only app IDs, folder names, ordering, dock entries and a
wallpaper selection. SQLite keys are SHA-256 hashes of the exact issuer and
subject. No credentials, OIDC tokens, groups, names or weather coordinates are
stored in the preferences database. Folder names are user-supplied data, so
protect and back up the volume. Concurrent updates use revision checks; a stale
browser receives a conflict and must refresh rather than overwrite newer state.

Back up the SQLite database using SQLite's supported online backup interface,
with its normal WAL/shared-memory files accessible. Do not copy a live database
file alone, use `immutable=1`, or ignore its WAL. For an offline backup, stop the
single writer cleanly first. Restore the consistent database to
`DASHBOARD_DATA_DIR/preferences.sqlite`, readable and writable by the application's
UID; keep the same OIDC issuer and stable subjects to recover the same layouts.
The catalog and secret references are separate deployment configuration.

Sessions and pending logins are bounded, expiring **in-memory** records. Restart
requires another SSO redirect but does not lose preferences. The browser attempts
automatic sign-in at most once per minute and provides a visible sign-in control
if it fails. Sign out ends the dashboard session; it does not sign out every
application or revoke the identity provider's global session.

Weather is off until the user grants browser location permission. Coordinates
are rounded to one decimal place before a direct request to Open-Meteo. This
application does not persist them or send them through its server. The provider
receives approximate coordinates and the browser's IP and has its own
[privacy and service terms](https://open-meteo.com/en/terms). Hide weather clears
the current weather state. Set `weatherEnabled: false` to remove this integration
entirely. The hosted free API permits noncommercial use; commercial distributors
must disable it or arrange an appropriately licensed implementation.

Optional OpenTelemetry emits only method, matched route template and HTTP status.
It does not automatically instrument outbound OIDC traffic or record full URLs,
query strings, cookies, request bodies, identities, groups, token values, or
location. No exporter runs when the endpoint is absent. Access logging is disabled
inside the app; review the gateway's logging policy separately.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

Unit tests exercise real `openid-client` protocol handling with a local synthetic
signing authority, state/nonce/PKCE failures, authorization isolation, CSRF,
expiry, host/origin checks, revocation, SQLite persistence and revision conflicts,
and telemetry attribute boundaries. Browser tests use a loopback-only demo and
exercise desktop/mobile layout, folders, search, reordering, dock, wallpapers and
cross-browser persistence. They make no requests to real media applications.

A local Chromium executable can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; otherwise Playwright's installed browser is
used. `test-results/` holds generated synthetic screenshots and is not committed.

With Helm available, run `node scripts/validate-chart.mjs` to check deployment
structure, inline and external catalogs, persistent storage, and routing options.
Set `HELM_BIN` if Helm is outside your executable path.

CI builds and tests the production image, checks the Helm package and deployment
variants, scans for secrets and known high/critical image vulnerabilities, and
publishes an attested immutable image reference. Live OIDC login and
deployment-specific authorization still require acceptance against your own
identity provider and gateway.

## License

Original code is MIT licensed. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled library, icon,
wallpaper and weather-service notices. Application names and logos remain their
owners' trademarks.
