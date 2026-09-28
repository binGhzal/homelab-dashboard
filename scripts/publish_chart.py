"""Publish a new chart version once, or verify and reuse its existing digest."""

import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request


MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
CHART_TYPE = "application/vnd.cncf.helm.config.v1+json"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


def request_json(url, authorization=None):
    request = urllib.request.Request(url, headers={"Accept": MANIFEST_TYPE})
    if authorization:
        request.add_unredirected_header("Authorization", authorization)
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise RuntimeError("Registry response exceeds size limit")
        return json.loads(body), response.headers, body


def registry_token(repository, actor=None, password=None):
    scope = f"repository:{repository}:pull" + (",push" if password else "")
    url = "https://ghcr.io/token?" + urllib.parse.urlencode(
        {"service": "ghcr.io", "scope": scope}
    )
    authorization = None
    if password:
        credentials = base64.b64encode(f"{actor}:{password}".encode()).decode()
        authorization = "Basic " + credentials
    data, _, _ = request_json(url, authorization)
    token = data.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Registry did not issue an access token")
    return token


def manifest_digest(repository, version, token):
    url = f"https://ghcr.io/v2/{repository}/manifests/{version}"
    try:
        manifest, headers, body = request_json(url, "Bearer " + token)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            details = json.loads(error.read(1024 * 1024))
            codes = {entry["code"] for entry in details.get("errors", [])}
            if codes and codes <= {"MANIFEST_UNKNOWN", "NAME_UNKNOWN"}:
                return None
        raise RuntimeError(f"Registry lookup failed with HTTP {error.code}") from None
    digest = headers.get("Docker-Content-Digest", "")
    expected = "sha256:" + hashlib.sha256(body).hexdigest()
    if not DIGEST.fullmatch(digest) or digest != expected:
        raise RuntimeError("Registry manifest digest is missing or incorrect")
    if manifest.get("config", {}).get("mediaType") != CHART_TYPE:
        raise RuntimeError("Existing version is not a Helm chart")
    return digest


def chart_contents(path):
    """Compare chart files, ignoring Helm's changing tar/gzip timestamps."""
    contents = {}
    total = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if (
                not member.isfile()
                or name.is_absolute()
                or ".." in name.parts
                or str(name) in contents
            ):
                raise RuntimeError("Chart archive contains an unsafe or duplicate entry")
            total += member.size
            if total > 10 * 1024 * 1024:
                raise RuntimeError("Chart archive exceeds size limit")
            contents[str(name)] = archive.extractfile(member).read()
    if not contents:
        raise RuntimeError("Chart archive is empty")
    return contents


def require_same_chart(expected, actual):
    if chart_contents(expected) != chart_contents(actual):
        raise RuntimeError(
            "Published chart version differs; increment Chart.yaml version. "
            "Existing versions are never replaced."
        )


def sole_package(directory):
    packages = list(directory.glob("*.tgz"))
    if len(packages) != 1:
        raise RuntimeError("Expected exactly one chart package")
    return packages[0]


def run_helm(helm, arguments, environment, input_text=None):
    result = subprocess.run(
        [helm, *arguments],
        input=input_text,
        text=True,
        capture_output=True,
        env=environment,
        check=True,
    )
    return result.stdout + result.stderr


def main():
    root = Path(__file__).resolve().parent.parent
    helm = os.environ.get("HELM_BIN", "helm")
    actor = os.environ["GITHUB_ACTOR"]
    password = os.environ["GH_TOKEN"]
    owner = os.environ["GITHUB_REPOSITORY_OWNER"].lower()
    if not re.fullmatch(r"[a-z0-9-]+", owner):
        raise RuntimeError("Invalid registry owner")
    with tempfile.TemporaryDirectory(prefix="dashboard-chart-publish-") as work:
        work = Path(work)
        environment = dict(os.environ)
        environment.pop("GH_TOKEN", None)
        environment["HELM_REGISTRY_CONFIG"] = str(work / "registry.json")
        Path(environment["HELM_REGISTRY_CONFIG"]).write_text('{"auths":{"ghcr.io":{}}}')
        environment["DOCKER_CONFIG"] = str(work / "docker")
        Path(environment["DOCKER_CONFIG"]).mkdir()
        (Path(environment["DOCKER_CONFIG"]) / "config.json").write_text('{"auths":{"ghcr.io":{}}}')
        package_dir = work / "package"
        package_dir.mkdir()
        run_helm(helm, ["package", str(root / "chart"), "-d", str(package_dir)], environment)
        package = sole_package(package_dir)
        metadata = run_helm(helm, ["show", "chart", str(package)], environment)
        name_match = re.search(r"^name: ([a-z0-9-]+)$", metadata, re.MULTILINE)
        version_match = re.search(r"^version: ([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$", metadata, re.MULTILINE)
        if not name_match or not version_match:
            raise RuntimeError("Chart name/version must be plain Helm semantic-version scalars")
        name, version = name_match[1], version_match[1]
        repository = f"{owner}/charts/{name}"
        reference = f"oci://ghcr.io/{repository}"
        tag = version.replace("+", "_")
        token = registry_token(repository, actor, password)
        digest = manifest_digest(repository, tag, token)
        run_helm(
            helm, ["registry", "login", "ghcr.io", "--username", actor, "--password-stdin"],
            environment, password + "\n",
        )
        if digest:
            existing_dir = work / "existing"
            existing_dir.mkdir()
            run_helm(helm, ["pull", f"{reference}@{digest}", "-d", str(existing_dir)], environment)
            require_same_chart(package, sole_package(existing_dir))
            print(f"Reusing existing chart {reference}:{version}@{digest}", flush=True)
        else:
            # Workflow concurrency serializes publishers. Recheck immediately before push.
            if manifest_digest(repository, tag, token) is not None:
                raise RuntimeError("Chart appeared during publication; retry to verify it")
            output = run_helm(helm, ["push", str(package), f"oci://ghcr.io/{owner}/charts"], environment)
            pushed = re.search(r"Digest: (sha256:[a-f0-9]{64})", output)
            digest = manifest_digest(repository, tag, token)
            if not pushed or pushed[1] != digest:
                raise RuntimeError("Published chart digest does not match the registry")
            print(f"Published chart {reference}:{version}@{digest}", flush=True)

        # Isolate both stores: Helm can otherwise fall back to Docker credentials.
        anonymous = dict(environment)
        anonymous["HELM_REGISTRY_CONFIG"] = str(work / "anonymous-registry.json")
        Path(anonymous["HELM_REGISTRY_CONFIG"]).write_text('{"auths":{"ghcr.io":{}}}')
        anonymous["DOCKER_CONFIG"] = str(work / "anonymous-docker")
        Path(anonymous["DOCKER_CONFIG"]).mkdir()
        (Path(anonymous["DOCKER_CONFIG"]) / "config.json").write_text('{"auths":{"ghcr.io":{}}}')
        anonymous_token = registry_token(repository)
        if manifest_digest(repository, tag, anonymous_token) != digest:
            raise RuntimeError("Anonymous version lookup did not match the published chart")
        for mode, arguments in (
            ("version", [reference, "--version", version]),
            ("digest", [f"{reference}@{digest}"]),
        ):
            destination = work / mode
            destination.mkdir()
            output = run_helm(helm, ["pull", *arguments, "-d", str(destination)], anonymous)
            if f"Digest: {digest}" not in output:
                raise RuntimeError("Anonymous pull resolved an unexpected chart digest")
            require_same_chart(package, sole_package(destination))
        print(f"Anonymous version and digest pulls verified: {reference}@{digest}")
        summary = f"Verified public Helm chart `{name}` version `{version}`: `{reference}@{digest}`\n"
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(summary)


if __name__ == "__main__":
    main()
