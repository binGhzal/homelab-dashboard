import { test, expect, type Locator } from "@playwright/test";

async function expectMenuUnclipped(menu: Locator) {
  await expect(menu).toBeVisible();
  expect(
    await menu.getByRole("menuitem").evaluateAll((items) =>
      items.every((item) => {
        const box = item.getBoundingClientRect();
        return [box.top + 4, box.bottom - 4].every((y) => {
          const hit = document.elementFromPoint(box.left + box.width / 2, y);
          return hit !== null && item.contains(hit);
        });
      }),
    ),
  ).toBe(true);
}

test("desktop, folders, search, dock, appearance and cross-browser preferences", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Good .*Alex/ }),
  ).toBeVisible();
  await expect(page.locator(".desktop-apps .launcher")).toHaveCount(9);
  await expect(page.getByText("Library", { exact: true })).toHaveCount(0);
  await expect(page.locator(".dock-app")).toHaveCount(4);
  await expect(page.locator(".app-icon img").first()).toBeVisible();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.getByRole("textbox", { name: "Search your apps" }).fill("sonarr");
  await expect(page.locator(".search-results > a")).toHaveCount(1);
  await expect(page.locator(".search-results")).toContainText("Sonarr");
  await page.getByRole("button", { name: "Close search" }).click();
  await page.getByRole("button", { name: "Desktop settings" }).click();
  await page.getByRole("button", { name: "Use midnight wallpaper" }).click();
  await expect(page.locator(".desktop-page")).toHaveClass(/wallpaper-midnight/);
  await page.getByRole("button", { name: "Use landscape wallpaper" }).click();
  await expect(page.locator(".desktop-page")).toHaveClass(
    /wallpaper-landscape/,
  );
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Watch");
  await page.getByRole("checkbox", { name: "Jellyfin" }).check();
  await page.getByRole("checkbox", { name: "Seerr", exact: true }).check();
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open folder Watch", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open folder Watch", exact: true })
    .click();
  await expect(page.locator(".folder-dialog .launcher")).toHaveCount(2);
  await page
    .locator(".folder-dialog")
    .getByRole("button", { name: "Options for Seerr", exact: true })
    .click();
  await expectMenuUnclipped(page.locator(".folder-dialog .context-menu"));
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  const folderItems = page.locator(".folder-dialog .desktop-item");
  await folderItems
    .filter({
      has: page.getByRole("link", { name: "Open Seerr", exact: true }),
    })
    .dragTo(
      folderItems.filter({
        has: page.getByRole("link", { name: "Open Jellyfin", exact: true }),
      }),
    );
  await expect(page.locator(".folder-dialog .app-name").first()).toHaveText(
    "Seerr",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".folder-dialog")
    .getByRole("button", { name: "Options for Seerr", exact: true })
    .click();
  await expectMenuUnclipped(page.locator(".folder-dialog .context-menu"));
  await page.getByRole("menuitem", { name: "Move later", exact: true }).click();
  await expect(page.locator(".folder-dialog .app-name").first()).toHaveText(
    "Jellyfin",
  );
  await page
    .locator(".folder-dialog")
    .getByRole("button", { name: "Options for Seerr", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move earlier", exact: true })
    .click();
  await expect(page.locator(".folder-dialog .app-name").first()).toHaveText(
    "Seerr",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Close folder" }).click();
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto("http://127.0.0.1:3024");
  await expect(
    secondPage.getByRole("button", { name: "Open folder Watch", exact: true }),
  ).toBeVisible();
  await second.close();
  await page
    .getByRole("button", { name: "Options for Radarr", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Remove from dock" }).click();
  await expect(page.locator(".dock-app")).toHaveCount(3);
  const items = page.locator(".desktop-apps > .app-grid > .desktop-item");
  await items
    .filter({
      has: page.getByRole("link", { name: "Open Grafana", exact: true }),
    })
    .dragTo(
      items.filter({
        has: page.getByRole("link", { name: "Open Sonarr", exact: true }),
      }),
    );
  await expect(page.locator(".desktop-apps .app-name").nth(1)).toHaveText(
    "Grafana",
  );
  await page.reload();
  await expect(page.locator(".desktop-apps .app-name").nth(1)).toHaveText(
    "Grafana",
  );
  await page
    .getByRole("button", { name: "Options for folder Watch", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove folder, keep apps" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open folder Watch", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".desktop-apps .launcher")).toHaveCount(9);
  expect(errors).toEqual([]);
});

test("weather refreshes while visible, pauses when hidden, and forgets location when cleared", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 25.2048, longitude: 55.2708 });
  const requests: string[] = [];
  await page.route("https://api.open-meteo.com/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      json: {
        current: { temperature_2m: 24 + requests.length, weather_code: 0 },
      },
    });
  });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Sample weather · Hide" }).click();
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.locator(".temperature")).toContainText("25");
  expect(requests).toHaveLength(1);
  const first = new URL(requests[0]);
  expect(first.searchParams.get("latitude")).toBe("25.2");
  expect(first.searchParams.get("longitude")).toBe("55.3");
  await page.clock.fastForward(14 * 60 * 1000);
  expect(requests).toHaveLength(1);
  await page.clock.fastForward(60 * 1000);
  await expect(page.locator(".temperature")).toContainText("26");
  expect(requests).toHaveLength(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30 * 60 * 1000);
  expect(requests).toHaveLength(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1);
  await expect(page.locator(".temperature")).toContainText("27");
  expect(requests).toHaveLength(3);
  await page.getByRole("button", { name: "Sample weather · Hide" }).click();
  await page.clock.fastForward(30 * 60 * 1000);
  expect(requests).toHaveLength(3);
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(JSON.stringify(stored)).not.toMatch(/25\.2|55\.3|latitude|longitude/);
});

test("pending weather requests are aborted on backgrounding and sign-out", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 25.2048, longitude: 55.2708 });
  await page.addInitScript(() => {
    const state = { started: 0, aborted: 0 };
    Object.defineProperty(window, "weatherRequests", { value: state });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (!String(input).startsWith("https://api.open-meteo.com/"))
        return originalFetch(input, options);
      state.started++;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          state.aborted++;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };
  });
  const counts = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            weatherRequests: { started: number; aborted: number };
          }
        ).weatherRequests,
    );
  await page.goto("/");
  await page.getByRole("button", { name: "Sample weather · Hide" }).click();
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect.poll(counts).toEqual({ started: 1, aborted: 0 });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(counts).toEqual({ started: 1, aborted: 1 });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect.poll(counts).toEqual({ started: 2, aborted: 1 });
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome home." }),
  ).toBeVisible();
  await expect.poll(counts).toEqual({ started: 2, aborted: 2 });
});
