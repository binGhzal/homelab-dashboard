import { createApp } from "./app.js";
import { loadCatalog, loadRuntime } from "./config.js";
import { createOidcProvider } from "./oidc.js";
import { demoCatalog } from "./demo.js";
import { startTelemetry } from "./telemetry.js";
import { PreferencesStore } from "./preferences.js";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

try {
  const runtime = loadRuntime();
  const telemetry = startTelemetry();
  if (!runtime.demo && !process.env.DASHBOARD_CONFIG)
    throw new Error("DASHBOARD_CONFIG required");
  const catalog = runtime.demo
    ? demoCatalog
    : loadCatalog(process.env.DASHBOARD_CONFIG!);
  const provider = runtime.demo ? undefined : await createOidcProvider(runtime);
  const directory = process.env.DASHBOARD_DATA_DIR;
  if (!runtime.demo && !directory)
    throw new Error("DASHBOARD_DATA_DIR required");
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = directory
    ? resolve(directory, "preferences.sqlite")
    : ":memory:";
  const preferences = new PreferencesStore(databasePath);
  if (directory) chmodSync(databasePath, 0o600);
  const app = await createApp({ runtime, catalog, provider, preferences });
  await app.listen({ host: runtime.host, port: runtime.port });
  console.log(
    `Dashboard listening on port ${runtime.port}${runtime.demo ? " (loopback-only synthetic demo)" : ""}`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void app.close().then(async () => {
        await telemetry?.shutdown();
        process.exit(0);
      });
    });
} catch {
  console.error(
    "Dashboard startup failed. Check catalogue, required environment, and identity-provider availability.",
  );
  process.exitCode = 1;
}
