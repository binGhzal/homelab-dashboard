import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3024",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command:
      "DASHBOARD_DEMO=true HOST=127.0.0.1 PORT=3024 PUBLIC_ORIGIN=http://127.0.0.1:3024 node dist/server/main.js",
    url: "http://127.0.0.1:3024/healthz",
    reuseExistingServer: false,
  },
});
