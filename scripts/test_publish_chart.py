import hashlib
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from publish_chart import chart_contents, main, manifest_digest, require_same_chart


class PublicationSafeguards(unittest.TestCase):
    def archive(self, directory, name, content=b"version: 0.1.0\n", timestamp=1, unsafe=False):
        path = Path(directory) / name
        with tarfile.open(path, "w:gz") as archive:
            entry = tarfile.TarInfo("homelab-dashboard/Chart.yaml")
            entry.mtime = timestamp
            entry.size = len(content)
            if unsafe:
                entry.type = tarfile.SYMTYPE
                entry.linkname = "/etc/passwd"
            archive.addfile(entry, io.BytesIO(content))
        return path

    def test_matching_files_ignore_packaging_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.archive(directory, "first.tgz", timestamp=1)
            second = self.archive(directory, "second.tgz", timestamp=2)
            self.assertNotEqual(first.read_bytes(), second.read_bytes())
            require_same_chart(first, second)

    def test_changed_contents_cannot_reuse_version(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.archive(directory, "first.tgz")
            second = self.archive(directory, "second.tgz", b"version: 0.2.0\n")
            with self.assertRaisesRegex(RuntimeError, "never replaced"):
                require_same_chart(first, second)

    def test_archive_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "unsafe"):
                chart_contents(self.archive(directory, "unsafe.tgz", unsafe=True))

    def test_only_recognized_not_found_allows_publication(self):
        for status, code in ((404, "MANIFEST_UNKNOWN"), (404, "NAME_UNKNOWN"), (401, "UNAUTHORIZED"), (403, "DENIED"), (500, "UNKNOWN"), (404, "DENIED")):
            with self.subTest(status=status, code=code):
                error = urllib.error.HTTPError("https://ghcr.io", status, "error", {}, io.BytesIO(json.dumps({"errors": [{"code": code}]}).encode()))
                with patch("publish_chart.request_json", side_effect=error):
                    if status == 404 and code in {"MANIFEST_UNKNOWN", "NAME_UNKNOWN"}:
                        self.assertIsNone(manifest_digest("example/charts/app", "0.1.0", "test-token"))
                    else:
                        with self.assertRaises(RuntimeError):
                            manifest_digest("example/charts/app", "0.1.0", "test-token")

    def test_existing_manifest_requires_correct_digest_and_helm_type(self):
        manifest = {"config": {"mediaType": "application/vnd.cncf.helm.config.v1+json"}}
        body = json.dumps(manifest).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        with patch("publish_chart.request_json", return_value=(manifest, {"Docker-Content-Digest": digest}, body)):
            self.assertEqual(manifest_digest("example/charts/app", "0.1.0", "test-token"), digest)
        for candidate, headers in ((manifest, {"Docker-Content-Digest": "sha256:" + "0" * 64}), ({"config": {"mediaType": "wrong"}}, {"Docker-Content-Digest": digest})):
            with patch("publish_chart.request_json", return_value=(candidate, headers, body)):
                with self.assertRaises(RuntimeError):
                    manifest_digest("example/charts/app", "0.1.0", "test-token")

    def test_existing_release_never_pushes_and_checks_anonymous_downloads(self):
        for changed in (False, True):
            with self.subTest(changed=changed):
                digest = "sha256:" + "a" * 64
                calls = []

                def helm(_binary, arguments, environment, input_text=None):
                    calls.append(arguments)
                    action = arguments[0]
                    if action == "package":
                        self.archive(arguments[-1], "homelab-dashboard-0.1.0.tgz")
                    elif action == "show":
                        return "name: homelab-dashboard\nversion: 0.1.0\n"
                    elif action == "pull":
                        destination = Path(arguments[-1])
                        contents = b"changed" if changed else b"version: 0.1.0\n"
                        # Helm digest downloads have a different filename from version pulls.
                        self.archive(destination, "homelab-dashboard@sha256-a.tgz", contents)
                        if destination.name in {"version", "digest"}:
                            for config in (
                                Path(environment["HELM_REGISTRY_CONFIG"]),
                                Path(environment["DOCKER_CONFIG"]) / "config.json",
                            ):
                                self.assertEqual(json.loads(config.read_text()), {"auths": {"ghcr.io": {}}})
                            self.assertNotIn("GH_TOKEN", environment)
                        return f"Digest: {digest}\n"
                    elif action == "push":
                        self.fail("An existing chart version must never be pushed again")
                    return ""

                environment = {
                    "GITHUB_ACTOR": "example",
                    "GITHUB_REPOSITORY_OWNER": "example",
                    "GH_TOKEN": "test-token",
                }
                with patch.dict(os.environ, environment, clear=True), patch(
                    "publish_chart.run_helm", side_effect=helm
                ), patch("publish_chart.registry_token", return_value="test-token"), patch(
                    "publish_chart.manifest_digest", return_value=digest
                ), redirect_stdout(io.StringIO()):
                    if changed:
                        with self.assertRaisesRegex(RuntimeError, "never replaced"):
                            main()
                    else:
                        main()
                        self.assertEqual(sum(call[0] == "pull" for call in calls), 3)


if __name__ == "__main__":
    unittest.main()
