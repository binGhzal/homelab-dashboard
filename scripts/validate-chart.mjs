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

function render(values) {
  const documents = parseAllDocuments(
    runHelm(["template", "dashboard", "chart"], values),
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
    (error) => error.stderr?.includes(message),
    `Expected Helm to reject: ${message}`,
  );
}

try {
  const externalValues = {
    image: { tag: "ci" },
    existingConfigMap: "external-catalog",
  };
  runHelm(["lint", "chart", "--strict"], externalValues);
  const external = render(externalValues);
  const externalPod = checkDeployment(external, "dashboard-data");
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
    "Helm chart validation passed: external and inline catalogs, rollout checksum, digest image, labels/env, storage, route, and invalid inputs.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
