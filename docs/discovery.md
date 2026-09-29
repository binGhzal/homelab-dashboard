# Permission-aware app discovery

Discovery adds already installed applications from explicitly marked Gateway API
HTTPRoutes. It does not install, update, restart or delete workloads. The default
chart and runtime leave discovery disabled. The global dashboard admission policy
and administrator groups continue to come from the static catalog; `apps: []` is
valid for a deployment whose apps all come from discovery.

## Single source of authorization

A trusted deployment owner must supply each discovered app's explicit `access`
policy. Generate this metadata from the same authoritative configuration that
secures the gateway or app, and reconcile it through the existing deployment
controller. Avoid maintaining a separate hand-edited permission inventory. The
runtime does not infer groups from hostnames, service names, labels, a route's
existence, or arbitrary identity-provider policy expressions.

Anyone who can edit opted-in HTTPRoute annotations can influence launcher
visibility and destinations for that namespace. Grant that write capability only
to the existing trusted deployment owner. This chart grants the dashboard no
write permission. Each application must independently enforce its own access;
launcher visibility does not secure an application URL.

## Route contract

Only `gateway.networking.k8s.io/v1` HTTPRoute objects in the configured namespaces
are eligible. Add the following metadata to the existing GitOps-owned route. This
fragment intentionally does not create a second route or modify its backend:

```yaml
metadata:
  labels:
    homelab-dashboard.io/discover: "true"
  annotations:
    homelab-dashboard.io/app: >-
      {"id":"photos","name":"Photos","description":"Your photo library","category":"Photos","iconSlug":"immich","access":{"allowAdmin":true,"anyOf":[{"allOf":["dashboard-users","app-photos"]}]}}
```

The JSON annotation is strict and at most 8 KiB. It accepts:

| Field                     | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                      | Required stable app ID, matching the static catalog ID rules                                 |
| `name`                    | Required display name                                                                        |
| `access`                  | Required existing dashboard policy: explicit `allowAdmin` and/or `anyOf` with `allOf` groups |
| `description`, `category` | Optional display text                                                                        |
| `iconSlug`                | Optional exact selfh.st reference, useful when app ID differs from the product               |
| `iconSource`              | `selfhst` by default; `local` disables remote icon lookup for this app                       |
| `iconPath`                | Optional same-origin `/icons/…` fallback                                                     |
| `hostname`                | Required selection when the route has more than one exact hostname                           |
| `path`                    | Optional launch path, default `/`                                                            |

The launch URL is derived from a non-wildcard route hostname with an HTTPS scheme.
A selected hostname must appear in `spec.hostnames`. Paths cannot change origin
or contain credentials, queries, fragments, traversal segments or control
characters. Configure an HTTPS gateway listener for this hostname. Discovery does
not fetch Gateway objects, certificates, DNS records or app endpoints, so it does
not independently prove TLS availability or application health.

The route must report `Accepted=True` and `ResolvedRefs=True` together on a parent
still declared in `spec.parentRefs`, for the current `metadata.generation`.
Unready, stale, malformed, unmarked or
unauthorized-namespace routes are omitted. An empty access policy grants nobody
access, including administrators. Duplicate IDs among discovered apps are all
omitted; a static catalog ID always wins over a discovered ID so discovery cannot
replace its policy or link. Keep IDs stable to retain existing layouts.

## Read-only Kubernetes mode

For chart 0.2.0, set:

```yaml
discovery:
  mode: kubernetes
  namespaces: [media, tools]
  intervalSeconds: 30
  maxAgeSeconds: 90
```

The chart creates a dedicated ServiceAccount with automatic token mounting
disabled. A projected, rotating service-account token and cluster CA are mounted
read-only at `/var/run/secrets/dashboard-discovery`. A Role and RoleBinding in each
listed namespace grant only `get` and `list` on HTTPRoutes. Installing the chart
therefore requires permission to manage these bindings in those existing
namespaces. Kubernetes RBAC cannot restrict list responses by label; the runtime
requests the opt-in label selector and validates it again before using a route.

The process only sends authenticated HTTPS GET requests to
`https://kubernetes.default.svc/apis/gateway.networking.k8s.io/v1/namespaces/…/httproutes`.
It validates the cluster CA, rejects redirects and rereads credentials per request
for rotation. Permit egress to the Kubernetes API through your existing network
policy. No Secret, ConfigMap, workload, pod or cluster-wide permissions are added.

## Projected snapshot mode

An existing trusted controller can collect the same route objects and publish a
ConfigMap key containing a JSON snapshot:

```json
{
  "version": 1,
  "generatedAt": "2026-09-29T12:00:00Z",
  "items": []
}
```

`items` contains complete opted-in HTTPRoute objects, including namespace,
generation, labels, annotation, hostnames and current parent conditions. The
example timestamp is illustrative; regenerate it on every successful source
reconciliation. A snapshot with a future timestamp more than 30 seconds ahead,
or age greater than or equal to `maxAgeSeconds`, cannot expose apps.

```yaml
discovery:
  mode: file
  namespaces: [media, tools]
  existingConfigMap: dashboard-discovery
  fileKey: routes.json
  intervalSeconds: 30
  maxAgeSeconds: 300
```

The ConfigMap must exist in the dashboard's namespace. Its selected key is
projected read-only to `/discovery/routes.json` without `subPath`, allowing normal
volume updates. No service account, discovery token or discovery RBAC is created.
Choose the refresh and expiry window to include controller cadence and Kubernetes
ConfigMap-volume propagation delay. An unchanged file eventually expires even if
it remains readable. Do not turn a failed source read into an apparently fresh
snapshot; expire it so obsolete permissions disappear.

## Environment contract and limits

The same modes can be configured outside Helm:

| Variable                               | Value                                                        |
| -------------------------------------- | ------------------------------------------------------------ |
| `DASHBOARD_DISCOVERY_MODE`             | Omit to disable; `kubernetes` or `file` to enable            |
| `DASHBOARD_DISCOVERY_NAMESPACES`       | Required comma-separated unique namespace list, 1–32 entries |
| `DASHBOARD_DISCOVERY_INTERVAL_SECONDS` | Integer 10–300; default 30                                   |
| `DASHBOARD_DISCOVERY_MAX_AGE_SECONDS`  | Integer from the poll interval to 900; default 90            |
| `DASHBOARD_DISCOVERY_FILE`             | Absolute snapshot path, required for file mode               |

Configuration is validated at startup. Collections are bounded to 100 routes,
2 MiB and bounded pagination. The combined static/discovered catalog supports at
most 100 apps; an over-capacity dynamic source is unavailable as a whole rather
than returning a truncated permission set. Missing files, invalid envelopes,
transport errors, failed namespace reads and expired data remove the entire
discovered set. Invalid individual routes are skipped and counted. A partial
namespace response never becomes a successful snapshot.

The default server poll is 30 seconds. The active browser refreshes its apps and
layout every 60 seconds; app-group changes are refreshed from UserInfo on new
requests after at most 60 seconds. These are separate freshness windows. Inactive
browsers retain already-rendered content until their next refresh. Neither
launcher removal nor dashboard sign-out terminates sessions inside linked apps.

## Status and layout recovery

Authenticated administrators can GET `/api/discovery`. It returns `state`
(`disabled`, `ready`, `unavailable` or `stale`), the last successful sync time,
namespace list, poll interval, accepted app count, skipped route count and static
ID override count. It returns no app names, URLs, policies, token contents or raw
upstream errors. Ordinary users receive 403; unauthenticated requests receive 401.
This is a read-only diagnostic endpoint; there is no refresh or mutation endpoint.

During an unavailable or stale source, static apps remain accessible. Reads filter
missing apps out of the visible layout without changing the stored preference
record. Preference writes receive 503 until discovery recovers, preventing a
temporary outage from overwriting folders and pinned apps. Normal healthy-source
removal and access revocation take effect immediately on subsequent API requests.

When discovery is configured, preference responses include an opaque
`catalogRevision` alongside the stored layout `revision`. A client must echo both
on PUT. The catalog revision reflects the caller's visible app IDs and discovery
state; a mismatch returns 409 and requires a fresh read. This also prevents a
layout loaded during an outage from overwriting recovered folders after the
source becomes healthy. The browser handles this contract automatically. Static
deployments retain their existing request format.
