import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

const evidenceDirectory = resolve(
  process.env.DASHBOARD_QA_DIR ?? "/tmp/dashboard-ui-revision",
);
const appNames = [
  "Jellyfin",
  "Immich",
  "Seerr",
  "Paperless-ngx",
  "Audiobookshelf",
  "Vaultwarden",
  "Syncthing",
  "Gitea",
  "FreshRSS",
];
const iconCdn = "https://cdn.jsdelivr.net/gh/selfhst/icons@main/";
const appIds = [
  "jellyfin",
  "immich",
  "seerr",
  "paperless-ngx",
  "audiobookshelf",
  "vaultwarden",
  "syncthing",
  "gitea",
  "freshrss",
];
async function mockIconCatalog(context: BrowserContext) {
  await context.route(`${iconCdn}**`, async (route) => {
    const relative = route.request().url().slice(iconCdn.length);
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (relative === "index.json") {
      await route.fulfill({
        headers,
        json: appIds.map((id, index) => ({
          Name: appNames[index],
          Reference: id,
          SVG: id === "seerr" ? "No" : "Yes",
          WebP: "No",
          PNG: "Yes",
        })),
      });
      return;
    }
    const id = appIds.find(
      (id) =>
        relative ===
        `${id === "seerr" ? "png" : "svg"}/${id}.${id === "seerr" ? "png" : "svg"}`,
    );
    if (!id) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({
      headers,
      path: resolve(
        import.meta.dirname,
        `../../public/icons/${id}.${id === "seerr" ? "png" : "svg"}`,
      ),
    });
  });
}

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});
test.beforeEach(async ({ request, context }, testInfo) => {
  await mockIconCatalog(context);
  const origin = new URL(testInfo.project.use.baseURL as string).origin;
  expect(new URL(origin).hostname).toBe("127.0.0.1");
  let userResponse = await request.get("/api/user");
  // Each case opens fresh browsers and loads the real assets. Reserve enough of
  // the server's shared request budget for a case without relaxing its limit.
  const remaining = Number(userResponse.headers()["x-ratelimit-remaining"]);
  const resetSeconds = Number(userResponse.headers()["x-ratelimit-reset"]);
  if (remaining < 100 && resetSeconds > 0 && resetSeconds <= 60) {
    const waitMilliseconds = resetSeconds * 1000 + 100;
    testInfo.setTimeout(testInfo.timeout + waitMilliseconds);
    await delay(waitMilliseconds);
    userResponse = await request.get("/api/user");
  }
  expect(userResponse.ok()).toBe(true);
  const user = await userResponse.json();
  expect(user.demo).toBe(true);
  const [catalogResponse, preferencesResponse] = await Promise.all([
    request.get("/api/apps"),
    request.get("/api/preferences"),
  ]);
  expect(catalogResponse.ok()).toBe(true);
  expect(preferencesResponse.ok()).toBe(true);
  const { apps } = await catalogResponse.json();
  const { revision } = await preferencesResponse.json();
  expect(apps.map((app: { name: string }) => app.name)).toEqual(appNames);
  const ids = apps.map((app: { id: string }) => app.id);
  const reset = await request.put("/api/preferences", {
    headers: { Origin: origin, "X-CSRF-Token": user.csrfToken },
    data: {
      revision,
      preferences: {
        version: 1,
        order: ids,
        folders: [],
        dock: ids.slice(0, 4),
        wallpaper: "landscape",
      },
    },
  });
  expect(reset.ok()).toBe(true);
});

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
function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return errors;
}
async function accountAction(page: Page, name: string) {
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page
    .getByRole("menu", { name: "Account menu" })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function openAppMenu(page: Page, name: string, insideFolder = false) {
  const scope = page.locator(insideFolder ? ".folder-dialog" : ".desktop-apps");
  await scope
    .getByRole("button", { name: `Options for ${name}`, exact: true })
    .click();
}
async function dockNames(page: Page) {
  return page.locator(".dock-app").evaluateAll((links) =>
    links.map((link) =>
      link
        .getAttribute("aria-label")
        ?.replace(/^Open /, "")
        .replace(/ from dock$/, ""),
    ),
  );
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
]) {
  test.describe(`desktop at ${viewport.width}px`, () => {
    test.use({
      viewport,
      hasTouch: viewport.width < 500,
      isMobile: viewport.width < 500,
    });
    test("account menu, keyboard focus, app-only dock and viewport layout", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      await page.goto("/");
      await expect(page).toHaveTitle("Home");
      await expect(
        page.getByRole("heading", { name: /Good .*Alex/ }),
      ).toBeVisible();
      await expect(page.locator(".desktop-apps .launcher")).toHaveCount(9);
      await expect(page.locator(".desktop-apps .app-name")).toHaveText(
        appNames,
      );
      await expect(page.locator(".desktop-apps .app-icon img")).toHaveCount(9);
      await expect
        .poll(() =>
          page
            .locator(".desktop-apps .app-icon img")
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      await expect(page.locator(".dock-app")).toHaveCount(4);
      await expect(page.locator(".desktop-dock button")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await expect(
        page.locator("vite-error-overlay, nextjs-portal"),
      ).toHaveCount(0);
      const account = page.getByRole("button", {
        name: "Your account",
        exact: true,
      });
      const accountBox = await account.boundingBox();
      expect(accountBox).not.toBeNull();
      expect(accountBox!.x).toBeGreaterThan(viewport.width / 2);
      expect(accountBox!.y).toBeLessThan(100);
      if (viewport.width < 500) await account.tap();
      else {
        await account.focus();
        await page.keyboard.press("Enter");
      }
      const menu = page.getByRole("menu", { name: "Account menu" });
      await expectMenuUnclipped(menu);
      await page.screenshot({
        path: resolve(evidenceDirectory, `account-menu-${viewport.width}.png`),
        fullPage: false,
      });
      const settings = menu.getByRole("menuitem", {
        name: "Desktop settings",
        exact: true,
      });
      await expect(settings).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "Rearrange apps", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        menu.getByRole("menuitem", { name: "Sign out", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(settings).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
      await expect(account).toBeFocused();
      await accountAction(page, "Desktop settings");
      await expect(
        page.getByRole("dialog", { name: "Settings", exact: true }),
      ).toBeVisible();
      const iconCredit = page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("link", { name: "selfh.st", exact: true });
      await expect(iconCredit).toHaveAttribute(
        "href",
        "https://selfh.st/icons/",
      );
      await expect(iconCredit).toHaveAttribute("rel", "noopener noreferrer");
      await expect(iconCredit).toBeVisible();
      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
      await expect(account).toBeFocused();
      await page.screenshot({
        path: resolve(evidenceDirectory, `desktop-${viewport.width}.png`),
        fullPage: false,
      });
      if (viewport.width < 500) {
        const lastApp = page
          .locator(".desktop-apps")
          .getByRole("link", { name: "Open FreshRSS", exact: true });
        await lastApp.scrollIntoViewIfNeeded();
        await lastApp.tap();
        await expect(
          page.getByRole("dialog", { name: "Local preview", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Back to desktop" }).tap();
        await expect(lastApp).toBeFocused();
      }
      expect(errors).toEqual([]);
    });
  });
}

test("folders create, rename, reorder and dissolve while preserving account layout", async ({
  page,
  browser,
}) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/");
  await accountAction(page, "New folder");
  await expect(
    page.getByRole("dialog", { name: "New folder", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Library");
  await page.getByRole("checkbox", { name: "Jellyfin", exact: true }).check();
  await page.getByRole("checkbox", { name: "Immich", exact: true }).check();
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  const folder = page.getByRole("button", {
    name: "Open folder Library",
    exact: true,
  });
  await expect(folder).toBeVisible();
  await folder.click();
  await expect(page.locator(".folder-dialog .launcher")).toHaveCount(2);
  const folderItems = page.locator(".folder-dialog .desktop-item");
  await folderItems
    .filter({
      has: page.getByRole("link", { name: "Open Immich", exact: true }),
    })
    .dragTo(
      folderItems.filter({
        has: page.getByRole("link", { name: "Open Jellyfin", exact: true }),
      }),
    );
  await expect(page.locator(".folder-dialog .app-name")).toHaveText([
    "Immich",
    "Jellyfin",
  ]);
  await openAppMenu(page, "Immich", true);
  await expectMenuUnclipped(
    page.getByRole("menu", { name: "Immich options", exact: true }),
  );
  await page.getByRole("menuitem", { name: "Move later", exact: true }).click();
  await expect(page.locator(".folder-dialog .app-name")).toHaveText([
    "Jellyfin",
    "Immich",
  ]);
  await page.getByRole("button", { name: "Close folder", exact: true }).click();
  await expect(folder).toBeFocused();
  await page
    .getByRole("button", { name: "Options for folder Library", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Rename folder", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Favorites");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open folder Favorites", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Options for folder Favorites", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move later", exact: true }).click();
  await expect(page.locator(".desktop-apps .app-name").nth(1)).toHaveText(
    "Favorites",
  );
  await page.reload();
  await expect(page.locator(".desktop-apps .app-name").nth(1)).toHaveText(
    "Favorites",
  );
  const second = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mockIconCatalog(second);
  try {
    const other = await second.newPage();
    await other.goto(new URL("/", page.url()).href);
    await other
      .getByRole("button", { name: "Open folder Favorites", exact: true })
      .tap();
    await expect(other.locator(".folder-dialog .app-name")).toHaveText([
      "Jellyfin",
      "Immich",
    ]);
    await other
      .locator(".folder-dialog")
      .getByRole("button", { name: "Options for Immich", exact: true })
      .tap();
    await expectMenuUnclipped(
      other.getByRole("menu", { name: "Immich options", exact: true }),
    );
    await other.screenshot({
      path: resolve(evidenceDirectory, "folder-menu-touch.png"),
      fullPage: false,
    });
    await other
      .getByRole("menuitem", { name: "Move earlier", exact: true })
      .tap();
    await expect(other.locator(".folder-dialog .app-name")).toHaveText([
      "Immich",
      "Jellyfin",
    ]);
    await other.screenshot({
      path: resolve(evidenceDirectory, "folder-touch.png"),
      fullPage: false,
    });
  } finally {
    await second.close();
  }
  await page.reload();
  await page
    .getByRole("button", { name: "Open folder Favorites", exact: true })
    .click();
  await expect(page.locator(".folder-dialog .app-name")).toHaveText([
    "Immich",
    "Jellyfin",
  ]);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open folder Favorites", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Options for folder Favorites", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove folder, keep apps", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open folder Favorites", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".desktop-apps .launcher")).toHaveCount(9);
  expect(
    [
      ...(await page.locator(".desktop-apps .app-name").allTextContents()),
    ].sort(),
  ).toEqual([...appNames].sort());
  expect(errors).toEqual([]);
});

test("keyboard desktop ordering, context menus, search and wallpaper controls", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/");
  await accountAction(page, "Rearrange apps");
  const jellyfin = page
    .locator(".desktop-apps")
    .getByRole("link", { name: "Open Jellyfin", exact: true });
  await jellyfin.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator(".desktop-apps .app-name").nth(1)).toHaveText(
    "Jellyfin",
  );
  await expect(jellyfin).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator(".desktop-apps .app-name").first()).toHaveText(
    "Jellyfin",
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const options = page.getByRole("button", {
    name: "Options for Immich",
    exact: true,
  });
  await options.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Immich options", exact: true });
  const enabledItems = menu.locator('[role="menuitem"]:not(:disabled)');
  await expect(enabledItems.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(enabledItems.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(enabledItems.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
  await jellyfin.focus();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("textbox", {
    name: "Search apps and actions",
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill("Immich");
  const result = page.locator(".search-results > a");
  await expect(result).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(result).toBeFocused();
  await page.screenshot({
    path: resolve(evidenceDirectory, "search-keyboard.png"),
    fullPage: false,
  });
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Local preview", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to desktop", exact: true })
    .click();
  await expect(search).not.toBeVisible();
  await expect(jellyfin).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(search).toBeFocused();
  await search.fill("no matching application");
  await expect(
    page.getByText("No results found", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeVisible();
  await expect(jellyfin).toBeFocused();
  await accountAction(page, "Desktop settings");
  for (const wallpaper of ["midnight", "dusk", "landscape"]) {
    await page
      .getByRole("button", { name: `Use ${wallpaper} wallpaper`, exact: true })
      .click();
    await expect(page.locator(".desktop-page")).toHaveClass(
      new RegExp(`wallpaper-${wallpaper}`),
    );
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Your account", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("dock customization adds, removes and reorders shortcuts with persistence", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/");
  expect(await dockNames(page)).toEqual(appNames.slice(0, 4));
  await accountAction(page, "Customize dock");
  const dialog = page.getByRole("dialog", {
    name: "Customize dock",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Remove Immich from dock", exact: true })
    .click();
  await expect(page.locator(".dock-app")).toHaveCount(3);
  await dialog
    .getByRole("button", { name: "Add Audiobookshelf to dock", exact: true })
    .click();
  await expect(page.locator(".dock-app")).toHaveCount(4);
  await dialog
    .getByRole("button", {
      name: "Move Audiobookshelf earlier in dock",
      exact: true,
    })
    .click();
  await expect
    .poll(() => dockNames(page))
    .toEqual(["Jellyfin", "Seerr", "Audiobookshelf", "Paperless-ngx"]);
  await dialog
    .getByRole("button", {
      name: "Move Audiobookshelf later in dock",
      exact: true,
    })
    .click();
  await expect
    .poll(() => dockNames(page))
    .toEqual(["Jellyfin", "Seerr", "Paperless-ngx", "Audiobookshelf"]);
  await page.screenshot({
    path: resolve(evidenceDirectory, "dock-customization.png"),
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Close dock customization", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Your account", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect
    .poll(() => dockNames(page))
    .toEqual(["Jellyfin", "Seerr", "Paperless-ngx", "Audiobookshelf"]);
  await page
    .getByRole("link", { name: "Open Audiobookshelf from dock", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Local preview", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to desktop", exact: true })
    .click();
  expect(errors).toEqual([]);
});

test.describe("small-screen dock and dialog transitions", () => {
  test.use({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
    isMobile: true,
  });
  test("touch controls stay reachable and dialogs restore focus at 320px and 390px", async ({
    page,
  }) => {
    const errors = collectBrowserErrors(page);
    await page.goto("/");
    const account = page.getByRole("button", {
      name: "Your account",
      exact: true,
    });
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await account.tap();
      await page
        .getByRole("menuitem", { name: "Desktop settings", exact: true })
        .tap();
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await settings
        .getByRole("button", { name: "Customize dock", exact: true })
        .tap();
      const dock = page.getByRole("dialog", {
        name: "Customize dock",
        exact: true,
      });
      await expect(dock).toBeVisible();
      await expect(settings).not.toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Close dock customization",
          exact: true,
        }),
      ).toBeFocused();
      expect(
        await dock.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        ),
      ).toBe(false);
      const box = await dock.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: resolve(
          evidenceDirectory,
          `dock-customization-${viewport.width}.png`,
        ),
        fullPage: false,
      });
      const lastChoice = dock.getByRole("button", {
        name: "Add FreshRSS to dock",
        exact: true,
      });
      await lastChoice.scrollIntoViewIfNeeded();
      await lastChoice.tap();
      await expect(page.locator(".dock-app")).toHaveCount(5);
      await dock
        .getByRole("button", {
          name: "Move FreshRSS earlier in dock",
          exact: true,
        })
        .tap();
      await expect
        .poll(() => dockNames(page))
        .toEqual(["Jellyfin", "Immich", "Seerr", "FreshRSS", "Paperless-ngx"]);
      await dock
        .getByRole("button", { name: "Remove FreshRSS from dock", exact: true })
        .tap();
      await expect(page.locator(".dock-app")).toHaveCount(4);
      await page
        .getByRole("button", { name: "Close dock customization", exact: true })
        .tap();
      await expect(account).toBeFocused();
      await account.tap();
      await page
        .getByRole("menuitem", { name: "Desktop settings", exact: true })
        .tap();
      await settings
        .getByRole("button", { name: "Create folder", exact: true })
        .tap();
      const folder = page.getByRole("dialog", {
        name: "New folder",
        exact: true,
      });
      await expect(folder).toBeVisible();
      await expect(settings).not.toBeVisible();
      await expect(
        folder.getByRole("textbox", { name: "Folder name" }),
      ).toBeFocused();
      expect(
        await folder.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        ),
      ).toBe(false);
      await folder
        .getByRole("button", { name: "Cancel folder", exact: true })
        .tap();
      await expect(account).toBeFocused();
    }
    await accountAction(page, "Customize dock");
    const dock = page.getByRole("dialog", {
      name: "Customize dock",
      exact: true,
    });
    for (const [index, name] of [
      "Audiobookshelf",
      "Vaultwarden",
      "Syncthing",
      "Gitea",
    ].entries()) {
      await dock
        .getByRole("button", { name: `Add ${name} to dock`, exact: true })
        .tap();
      await expect(page.locator(".dock-app")).toHaveCount(5 + index);
    }
    await expect(
      dock.getByRole("button", { name: "Add FreshRSS to dock", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Close dock customization", exact: true })
      .tap();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      const lastPinned = page.getByRole("link", {
        name: "Open Gitea from dock",
        exact: true,
      });
      await lastPinned.scrollIntoViewIfNeeded();
      await lastPinned.tap();
      await expect(
        page.getByRole("dialog", { name: "Local preview", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Back to desktop", exact: true })
        .tap();
      await expect(lastPinned).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
});

test("a stale folder draft stays visible and can recover after another browser saves", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await accountAction(page, "New folder");
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog
    .getByRole("textbox", { name: "Folder name" })
    .fill("Shared shelf");
  await dialog.getByRole("checkbox", { name: "Jellyfin", exact: true }).check();
  const second = await browser.newContext();
  await mockIconCatalog(second);
  try {
    const other = await second.newPage();
    await other.goto(new URL("/", page.url()).href);
    await accountAction(other, "Desktop settings");
    await other
      .getByRole("button", { name: "Use dusk wallpaper", exact: true })
      .click();
    await expect(other.locator(".desktop-page")).toHaveClass(/wallpaper-dusk/);
  } finally {
    await second.close();
  }
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/preferences") &&
      response.request().method() === "PUT",
  );
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  expect((await conflict).status()).toBe(409);
  const alert = dialog.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Your layout or available apps changed");
  await expect(
    dialog.getByRole("textbox", { name: "Folder name" }),
  ).toHaveValue("Shared shelf");
  await expect(
    dialog.getByRole("checkbox", { name: "Jellyfin", exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: resolve(evidenceDirectory, "folder-conflict-recovery.png"),
    fullPage: false,
  });
  await alert
    .getByRole("button", { name: "Refresh layout", exact: true })
    .click();
  await expect(alert).not.toBeVisible();
  await expect(page.locator(".desktop-page")).toHaveClass(/wallpaper-dusk/);
  await expect(
    dialog.getByRole("textbox", { name: "Folder name" }),
  ).toHaveValue("Shared shelf");
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open folder Shared shelf", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open folder Shared shelf", exact: true }),
  ).toBeVisible();
});

test("discovery save failures retain the draft and retry with the refreshed catalog revision", async ({
  page,
  request,
}) => {
  const initialToken = "a".repeat(64);
  const refreshedToken = "b".repeat(64);
  let catalogRevision = initialToken;
  const writtenTokens: unknown[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const original = await (await request.get("/api/preferences")).json();
  await page.route("**/api/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      writtenTokens.push(route.request().postDataJSON().catalogRevision);
      if (writtenTokens.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "App discovery is temporarily unavailable." },
        });
        return;
      }
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), catalogRevision },
    });
  });
  await page.goto("/");
  await accountAction(page, "New folder");
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const name = dialog.getByRole("textbox", { name: "Folder name" });
  const selection = dialog.getByRole("checkbox", {
    name: "Jellyfin",
    exact: true,
  });
  await name.fill("Discovery shelf");
  await selection.check();
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("App discovery is temporarily unavailable");
  await expect(alert).toContainText("Your saved layout is unchanged");
  await expect(name).toHaveValue("Discovery shelf");
  await expect(selection).toBeChecked();
  expect(writtenTokens).toEqual([initialToken]);
  expect(await (await request.get("/api/preferences")).json()).toEqual(
    original,
  );
  await page.screenshot({
    path: resolve(evidenceDirectory, "folder-discovery-unavailable.png"),
    fullPage: false,
  });

  catalogRevision = refreshedToken;
  await alert
    .getByRole("button", { name: "Refresh layout", exact: true })
    .click();
  await expect(alert).not.toBeVisible();
  await expect(name).toHaveValue("Discovery shelf");
  await expect(selection).toBeChecked();
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open folder Discovery shelf",
      exact: true,
    }),
  ).toBeVisible();
  expect(writtenTokens).toEqual([initialToken, refreshedToken]);

  // A successful PUT response must retain the token for the next edit too.
  await accountAction(page, "Desktop settings");
  await page
    .getByRole("button", { name: "Use dusk wallpaper", exact: true })
    .click();
  await expect(page.locator(".desktop-page")).toHaveClass(/wallpaper-dusk/);
  expect(writtenTokens).toEqual([initialToken, refreshedToken, refreshedToken]);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Open folder Discovery shelf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".desktop-page")).toHaveClass(/wallpaper-dusk/);
  expect(pageErrors).toEqual([]);
});

test("catalog IDs account and desktop cannot replace the system menus", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  const aliases: Record<string, string> = {
    jellyfin: "account",
    immich: "desktop",
  };
  await page.route("**/api/apps", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.apps = body.apps.map((app: { id: string; name: string }) => ({
      ...app,
      id: aliases[app.id] ?? app.id,
      name: aliases[app.id] ? `${aliases[app.id]} tools` : app.name,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/preferences", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const field of ["order", "dock"])
      body.preferences[field] = body.preferences[field].map(
        (id: string) => aliases[id] ?? id,
      );
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(
    page
      .locator(".desktop-apps")
      .getByRole("link", { name: "Open account tools", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".desktop-apps")
      .getByRole("link", { name: "Open desktop tools", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  const account = page.getByRole("menu", { name: "Account menu", exact: true });
  await expect(
    account.getByRole("menuitem", { name: "Desktop settings", exact: true }),
  ).toBeVisible();
  await expect(
    account.getByRole("menuitem", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".apps-heading h2").click({ button: "right" });
  const desktop = page.getByRole("menu", {
    name: "Desktop options",
    exact: true,
  });
  await expect(
    desktop.getByRole("menuitem", { name: "Desktop settings", exact: true }),
  ).toBeVisible();
  await expect(
    desktop.getByRole("menuitem", { name: "New folder", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openAppMenu(page, "account tools");
  await expect(
    page
      .getByRole("menu", { name: "account tools options", exact: true })
      .getByRole("menuitem", { name: "Remove from dock", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the command palette groups apps and actions and restores its original focus", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/");
  const launcher = page
    .locator(".desktop-apps")
    .getByRole("link", { name: "Open Jellyfin", exact: true });
  const palette = page.getByRole("dialog", {
    name: "Search apps and actions",
    exact: true,
  });
  const input = palette.getByRole("textbox", {
    name: "Search apps and actions",
    exact: true,
  });
  const cases = [
    { query: "preferences", action: "Desktop settings", dialog: "Settings" },
    { query: "background", action: "Change wallpaper", dialog: "Settings" },
    { query: "new folder", action: "New folder", dialog: "New folder" },
    { query: "pin", action: "Customize dock", dialog: "Customize dock" },
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await launcher.focus();
    await page.keyboard.press("Control+k");
    await expect(palette.getByRole("heading", { name: /^Apps/ })).toBeVisible();
    await expect(
      palette.getByRole("heading", { name: /^Actions/ }),
    ).toBeVisible();
    await expect(palette.locator("a[data-search-result]")).toHaveCount(9);
    await expect(palette.locator(".search-action")).toHaveCount(5);
    // Arrow navigation crosses the section boundary in rendered result order.
    for (let index = 0; index < 10; index++)
      await page.keyboard.press("ArrowDown");
    await expect(
      palette.getByRole("button", { name: "Desktop settings", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(palette.locator("a[data-search-result]").last()).toBeFocused();
    await input.fill("re");
    await input.focus();
    await page.screenshot({
      path: resolve(evidenceDirectory, `command-palette-${width}.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
    for (const item of cases) {
      await page.keyboard.press("Control+k");
      await input.fill(item.query);
      await expect(
        palette.getByRole("button", { name: item.action, exact: true }),
      ).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(
        palette.getByRole("button", { name: item.action, exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: item.dialog,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(palette).not.toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      if (item.action === "Desktop settings") {
        await page.screenshot({
          path: resolve(evidenceDirectory, `settings-icons-${width}.png`),
          fullPage: false,
        });
      }
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(launcher).toBeFocused();
    }
    await page.keyboard.press("Control+k");
    await input.fill("reorder");
    // Enter from the input activates the first matching action too.
    await page.keyboard.press("Enter");
    await expect(palette).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    await expect(launcher).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).not.toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("palette keyboard navigation skips actions unavailable without authorized apps", async ({
  page,
}) => {
  await page.route("**/api/apps", (route) =>
    route.fulfill({ json: { apps: [] } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Your account", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", {
    name: "Search apps and actions",
    exact: true,
  });
  await expect(
    palette.getByRole("button", { name: "New folder", exact: true }),
  ).toBeDisabled();
  await expect(
    palette.getByRole("button", { name: "Rearrange apps", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(
    palette.getByRole("button", { name: "Desktop settings", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    palette.getByRole("button", { name: "Customize dock", exact: true }),
  ).toBeFocused();
  await palette.getByRole("textbox").fill("Jellyfin");
  await expect(
    palette.getByText("No results found", { exact: true }),
  ).toBeVisible();
  await expect(palette.locator("a[data-search-result]")).toHaveCount(0);
});

test("the published icon index resolves remote artwork in the rendered desktop", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  const indexRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url() === `${iconCdn}index.json`)
      indexRequests.push(request.url());
  });
  await page.goto("/");
  for (const id of appIds) {
    const image = page.locator(
      `.desktop-apps .app-icon[data-brand="${id}"] img`,
    );
    const format = id === "seerr" ? "png" : "svg";
    await expect(image).toHaveAttribute(
      "src",
      `${iconCdn}${format}/${id}.${format}`,
    );
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  expect(indexRequests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("an unreadable remote icon falls back to bundled artwork", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route(`${iconCdn}svg/jellyfin.svg`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      contentType: "image/svg+xml",
      body: "invalid image",
    }),
  );
  const failedImage = page.waitForResponse(`${iconCdn}svg/jellyfin.svg`);
  await page.goto("/");
  await failedImage;
  const fallback = page.locator(
    '.desktop-apps .app-icon[data-brand="jellyfin"] img',
  );
  await expect(fallback).toHaveAttribute("src", "/icons/jellyfin.svg");
  await expect
    .poll(() =>
      fallback.evaluate(
        (element) => (element as HTMLImageElement).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
  const remote = page.locator(
    '.desktop-apps .app-icon[data-brand="immich"] img',
  );
  await expect(remote).toHaveAttribute("src", `${iconCdn}svg/immich.svg`);
  expect(failures).toEqual([]);
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
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome home." }),
  ).toBeVisible();
  await expect.poll(counts).toEqual({ started: 2, aborted: 2 });
});
