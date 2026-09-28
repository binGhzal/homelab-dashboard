import { test, expect } from "@playwright/test";
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
