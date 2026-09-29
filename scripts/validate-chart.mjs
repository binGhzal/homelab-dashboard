import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helm = process.env.HELM_BIN || "helm";
const directory = mkdtempSync(join(tmpdir(), "dashboard-chart-"));
let nextFile = 0;

function valuesFile(values) {
  const path = join(directory, `${nextFile++}.yaml`);
  writeFileSync(path, stringify(values));
  return path;
}

function runHelm(command, values) {
  return execFileSync(helm, [...command, "-f", valuesFile(values)], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function render(values, namespace = "default") {
  const documents = parseAllDocuments(
    runHelm(
      ["template", "dashboard", "chart", "--namespace", namespace],
      values,
    ),
  );
  for (const document of documents) assert.deepEqual(document.errors, []);
  return documents.map((document) => document.toJS()).filter(Boolean);
}

function resource(documents, kind) {
  const matches = documents.filter((document) => document.kind === kind);
  assert.equal(matches.length, 1, `Expected one ${kind}`);
  return matches[0];
}

function checkDeployment(documents, claimName) {
  const deployment = resource(documents, "Deployment");
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(deployment.spec.claimName, undefined);
  const pod = deployment.spec.template;
  const data = pod.spec.volumes.find((volume) => volume.name === "data");
  assert.deepEqual(data, {
    name: "data",
    persistentVolumeClaim: { claimName },
  });
  for (const [key, value] of Object.entries(
    deployment.spec.selector.matchLabels,
  )) {
    assert.equal(
      pod.metadata.labels[key],
      value,
      "Selector must match the pod labels",
    );
  }
  assert.deepEqual(
    resource(documents, "Service").spec.selector,
    deployment.spec.selector.matchLabels,
  );
  return pod;
}

function mustReject(values, message) {
  assert.throws(
    () => render(values),
    (error) =>
      error.stderr?.includes(message) ||
      error.stderr?.includes(message.replaceAll(".", "/")),
    `Expected Helm to reject: ${message}`,
  );
}

function discoveryEnv(pod) {
  return Object.fromEntries(
    pod.spec.containers[0].env
      .filter((entry) => entry.name.startsWith("DASHBOARD_DISCOVERY_"))
      .map((entry) => [entry.name, entry.value]),
  );
}

function checkNoDiscoveryCredentials(documents, pod) {
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.serviceAccountName, undefined);
  for (const kind of [
    "ServiceAccount",
    "Role",
    "RoleBinding",
    "ClusterRole",
    "ClusterRoleBinding",
    "Secret",
  ]) {
    assert.equal(
      documents.filter((document) => document.kind === kind).length,
      0,
      `Unexpected ${kind}`,
    );
  }
  for (const volume of pod.spec.volumes) {
    assert.equal(volume.secret, undefined);
    for (const source of volume.projected?.sources ?? []) {
      assert.equal(source.serviceAccountToken, undefined);
      assert.equal(source.secret, undefined);
    }
  }
}

try {
  const externalValues = {
    image: { tag: "ci" },
    existingConfigMap: "external-catalog",
  };
  runHelm(["lint", "chart", "--strict"], externalValues);
  const external = render(externalValues);
  const externalPod = checkDeployment(external, "dashboard-data");
  checkNoDiscoveryCredentials(external, externalPod);
  assert.deepEqual(discoveryEnv(externalPod), {});
  assert.equal(
    externalPod.spec.volumes.some((volume) =>
      volume.name.startsWith("discovery"),
    ),
    false,
  );
  assert.equal(
    external.filter((document) => document.kind === "ConfigMap").length,
    0,
  );
  assert.equal(externalPod.metadata.annotations, undefined);
  assert.equal(
    externalPod.spec.volumes.find((volume) => volume.name === "catalog")
      .configMap.name,
    "external-catalog",
  );
  assert.equal(
    externalPod.spec.containers[0].image,
    "ghcr.io/binghzal/homelab-dashboard:ci",
  );
  const retainedClaim = resource(external, "PersistentVolumeClaim");
  assert.equal(
    retainedClaim.metadata.annotations["helm.sh/resource-policy"],
    "keep",
  );
  assert.deepEqual(retainedClaim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(retainedClaim.spec.resources.requests.storage, "1Gi");

  const catalog = parse(
    readFileSync(join(root, "config/catalog.example.yaml"), "utf8"),
  );
  const inlineValues = { image: { tag: "ci" }, catalog };
  runHelm(["lint", "chart", "--strict"], inlineValues);
  const inline = render(inlineValues);
  const inlinePod = checkDeployment(inline, "dashboard-data");
  const catalogMap = resource(inline, "ConfigMap");
  assert.equal(catalogMap.metadata.name, "dashboard-catalog");
  assert.deepEqual(parse(catalogMap.data["catalog.yaml"]), catalog);
  const checksum = inlinePod.metadata.annotations["checksum/catalog"];
  assert.match(checksum, /^[a-f0-9]{64}$/);
  const changed = render({
    ...inlineValues,
    catalog: { ...catalog, title: "Changed title" },
  });
  assert.notEqual(
    resource(changed, "Deployment").spec.template.metadata.annotations[
      "checksum/catalog"
    ],
    checksum,
  );

  const digest = `sha256:${"a".repeat(64)}`;
  const advanced = render({
    ...externalValues,
    image: { tag: "ignored-when-digest-is-set", digest },
    persistence: { existingClaim: "existing-data" },
    podLabels: {
      department: "example",
      "app.kubernetes.io/name": "must-not-break-selector",
    },
    extraEnv: [{ name: "OTEL_SERVICE_NAME", value: "desktop" }],
    imagePullSecrets: [{ name: "registry" }],
    nodeSelector: { "kubernetes.io/os": "linux" },
    tolerations: [
      {
        key: "dedicated",
        operator: "Equal",
        value: "apps",
        effect: "NoSchedule",
      },
    ],
    httpRoute: {
      enabled: true,
      hostname: "desktop.example.com",
      parentRefs: [
        { name: "private-gateway", namespace: "gateway", sectionName: "https" },
      ],
    },
  });
  const advancedPod = checkDeployment(advanced, "existing-data");
  assert.equal(
    advanced.filter((document) => document.kind === "PersistentVolumeClaim")
      .length,
    0,
  );
  assert.equal(advancedPod.metadata.labels.department, "example");
  assert.equal(
    advancedPod.spec.containers[0].image,
    `ghcr.io/binghzal/homelab-dashboard@${digest}`,
  );
  assert.deepEqual(
    advancedPod.spec.containers[0].env.find(
      (entry) => entry.name === "OTEL_SERVICE_NAME",
    ),
    { name: "OTEL_SERVICE_NAME", value: "desktop" },
  );
  assert.deepEqual(advancedPod.spec.imagePullSecrets, [{ name: "registry" }]);
  assert.deepEqual(advancedPod.spec.nodeSelector, {
    "kubernetes.io/os": "linux",
  });
  assert.equal(advancedPod.spec.tolerations[0].value, "apps");
  const route = resource(advanced, "HTTPRoute");
  assert.deepEqual(route.spec.hostnames, ["desktop.example.com"]);
  assert.deepEqual(route.spec.parentRefs, [
    { name: "private-gateway", namespace: "gateway", sectionName: "https" },
  ]);
  assert.deepEqual(route.spec.rules, [
    { backendRefs: [{ name: "dashboard", port: 3000 }] },
  ]);

  const storage = render({
    ...externalValues,
    persistence: { storageClassName: "example-storage", size: "2Gi" },
  });
  assert.equal(
    resource(storage, "PersistentVolumeClaim").spec.storageClassName,
    "example-storage",
  );
  assert.equal(
    resource(storage, "PersistentVolumeClaim").spec.resources.requests.storage,
    "2Gi",
  );

  const kubernetesValues = {
    ...externalValues,
    discovery: { mode: "kubernetes", namespaces: ["media", "documents"] },
  };
  runHelm(["lint", "chart", "--strict"], kubernetesValues);
  const kubernetes = render(kubernetesValues, "dashboard-system");
  const kubernetesPod = checkDeployment(kubernetes, "dashboard-data");
  assert.equal(kubernetesPod.spec.automountServiceAccountToken, false);
  assert.equal(kubernetesPod.spec.serviceAccountName, "dashboard-discovery");
  assert.deepEqual(discoveryEnv(kubernetesPod), {
    DASHBOARD_DISCOVERY_MODE: "kubernetes",
    DASHBOARD_DISCOVERY_NAMESPACES: "media,documents",
    DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "30",
    DASHBOARD_DISCOVERY_MAX_AGE_SECONDS: "90",
  });
  const account = resource(kubernetes, "ServiceAccount");
  assert.equal(account.metadata.name, "dashboard-discovery");
  assert.equal(account.metadata.namespace, "dashboard-system");
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(account.secrets, undefined);
  assert.deepEqual(
    kubernetesPod.spec.volumes.find(
      (volume) => volume.name === "discovery-api",
    ),
    {
      name: "discovery-api",
      projected: {
        defaultMode: 288,
        sources: [
          { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
          {
            configMap: {
              name: "kube-root-ca.crt",
              items: [{ key: "ca.crt", path: "ca.crt" }],
            },
          },
        ],
      },
    },
  );
  assert.deepEqual(
    kubernetesPod.spec.containers[0].volumeMounts.find(
      (mount) => mount.name === "discovery-api",
    ),
    {
      name: "discovery-api",
      mountPath: "/var/run/secrets/dashboard-discovery",
      readOnly: true,
    },
  );
  for (const kind of ["ClusterRole", "ClusterRoleBinding", "Secret"]) {
    assert.equal(
      kubernetes.filter((document) => document.kind === kind).length,
      0,
    );
  }
  for (const kind of ["Role", "RoleBinding"]) {
    const scoped = kubernetes.filter((document) => document.kind === kind);
    assert.deepEqual(
      scoped.map((document) => document.metadata.namespace).sort(),
      ["documents", "media"],
    );
    for (const document of scoped) {
      assert.equal(
        document.metadata.name,
        "dashboard-system-dashboard-discovery",
      );
      if (kind === "Role") {
        assert.deepEqual(document.rules, [
          {
            apiGroups: ["gateway.networking.k8s.io"],
            resources: ["httproutes"],
            verbs: ["get", "list"],
          },
        ]);
      } else {
        assert.deepEqual(document.subjects, [
          {
            kind: "ServiceAccount",
            name: "dashboard-discovery",
            namespace: "dashboard-system",
          },
        ]);
        assert.deepEqual(document.roleRef, {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: "dashboard-system-dashboard-discovery",
        });
      }
    }
  }
  // Different releases named dashboard in different namespaces must not share RBAC objects.
  const otherNamespace = render(kubernetesValues, "other-dashboard");
  assert.equal(
    otherNamespace.find((document) => document.kind === "Role").metadata.name,
    "other-dashboard-dashboard-discovery",
  );

  const fileValues = {
    ...externalValues,
    discovery: {
      mode: "file",
      namespaces: ["media"],
      intervalSeconds: 45,
      maxAgeSeconds: 120,
      existingConfigMap: "route-snapshot",
      fileKey: "snapshot.json",
    },
  };
  runHelm(["lint", "chart", "--strict"], fileValues);
  const file = render(fileValues);
  const filePod = checkDeployment(file, "dashboard-data");
  checkNoDiscoveryCredentials(file, filePod);
  assert.deepEqual(discoveryEnv(filePod), {
    DASHBOARD_DISCOVERY_MODE: "file",
    DASHBOARD_DISCOVERY_NAMESPACES: "media",
    DASHBOARD_DISCOVERY_INTERVAL_SECONDS: "45",
    DASHBOARD_DISCOVERY_MAX_AGE_SECONDS: "120",
    DASHBOARD_DISCOVERY_FILE: "/discovery/routes.json",
  });
  assert.deepEqual(
    filePod.spec.volumes.find((volume) => volume.name === "discovery-file"),
    {
      name: "discovery-file",
      projected: {
        defaultMode: 292,
        sources: [
          {
            configMap: {
              name: "route-snapshot",
              items: [{ key: "snapshot.json", path: "routes.json" }],
            },
          },
        ],
      },
    },
  );
  assert.deepEqual(
    filePod.spec.containers[0].volumeMounts.find(
      (mount) => mount.name === "discovery-file",
    ),
    {
      name: "discovery-file",
      mountPath: "/discovery",
      readOnly: true,
    },
  );
  assert.equal(
    file.filter((document) => document.kind === "ConfigMap").length,
    0,
  );
  const disabled = render({
    ...externalValues,
    discovery: { mode: "disabled", namespaces: ["media"] },
  });
  const disabledPod = checkDeployment(disabled, "dashboard-data");
  checkNoDiscoveryCredentials(disabled, disabledPod);
  assert.deepEqual(discoveryEnv(disabledPod), {});

  for (const [intervalSeconds, maxAgeSeconds] of [
    [10, 10],
    [300, 900],
  ]) {
    const boundary = render({
      ...kubernetesValues,
      discovery: {
        ...kubernetesValues.discovery,
        intervalSeconds,
        maxAgeSeconds,
      },
    });
    assert.equal(
      discoveryEnv(resource(boundary, "Deployment").spec.template)
        .DASHBOARD_DISCOVERY_INTERVAL_SECONDS,
      String(intervalSeconds),
    );
  }
  for (const mode of ["file", "kubernetes"]) {
    mustReject(
      { ...externalValues, discovery: { mode } },
      "discovery.namespaces",
    );
  }
  for (const namespaces of [
    ["media", "media"],
    ["*"],
    [""],
    ["Media"],
    ["media.apps"],
    ["-media"],
    ["media-"],
    ["media/routes"],
    ["n".repeat(64)],
    [42],
    Array.from({ length: 33 }, (_, index) => `namespace-${index}`),
  ]) {
    mustReject(
      { ...externalValues, discovery: { mode: "kubernetes", namespaces } },
      "discovery.namespaces",
    );
  }
  for (const [field, values] of Object.entries({
    mode: ["auto", "Kubernetes", true],
    intervalSeconds: [9, 301, 30.5, "30"],
    maxAgeSeconds: [9, 901, 90.5, "90"],
  })) {
    for (const value of values) {
      mustReject(
        {
          ...kubernetesValues,
          discovery: { ...kubernetesValues.discovery, [field]: value },
        },
        `discovery.${field}`,
      );
    }
  }
  mustReject(
    {
      ...kubernetesValues,
      discovery: {
        ...kubernetesValues.discovery,
        intervalSeconds: 100,
        maxAgeSeconds: 90,
      },
    },
    "discovery.maxAgeSeconds must be at least discovery.intervalSeconds",
  );
  for (const existingConfigMap of ["", "Invalid", "namespace/map"]) {
    mustReject(
      {
        ...fileValues,
        discovery: { ...fileValues.discovery, existingConfigMap },
      },
      "discovery.existingConfigMap",
    );
  }
  for (const fileKey of ["", "../routes.json", "path/routes.json"]) {
    mustReject(
      { ...fileValues, discovery: { ...fileValues.discovery, fileKey } },
      "discovery.fileKey",
    );
  }
  for (const name of [
    "DASHBOARD_DISCOVERY_MODE",
    "DASHBOARD_DISCOVERY_NAMESPACES",
    "DASHBOARD_DISCOVERY_FILE",
  ]) {
    mustReject(
      { ...externalValues, extraEnv: [{ name, value: "override" }] },
      "Configure discovery through discovery values",
    );
  }

  mustReject({ image: { tag: "ci" } }, "Set catalog or existingConfigMap");
  mustReject(
    { ...externalValues, catalog },
    "Set only one of catalog or existingConfigMap",
  );
  mustReject(
    { existingConfigMap: "external-catalog" },
    "Set image.digest or an immutable image.tag",
  );
  mustReject(
    { ...externalValues, httpRoute: { enabled: true } },
    "httpRoute.parentRefs is required",
  );
  mustReject(
    {
      ...externalValues,
      httpRoute: {
        enabled: true,
        hostname: "",
        parentRefs: [{ name: "gateway" }],
      },
    },
    "httpRoute.hostname is required",
  );
  console.log(
    "Helm chart validation passed: external and inline catalogs, rollout checksum, digest image, labels/env, storage, route, credential-free default, scoped Kubernetes discovery, file discovery, and invalid inputs.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
