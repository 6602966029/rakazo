import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, signup } from "./helpers";

async function captureSidebarSearchSelected(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const search = aside.getByTestId("sidebar-search");
  const selected = aside.getByRole("button", { name: /^Chief/ }).first();
  await expect(search).toBeVisible();
  await expect(selected).toBeVisible();
  await search.scrollIntoViewIfNeeded();

  const searchBox = await search.boundingBox();
  const selectedBox = await selected.boundingBox();
  expect(searchBox).toBeTruthy();
  expect(selectedBox).toBeTruthy();
  if (searchBox && selectedBox) {
    expect(Math.abs(searchBox.x - selectedBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(searchBox.x + searchBox.width - (selectedBox.x + selectedBox.width)),
    ).toBeLessThanOrEqual(1);
  }

  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.45, 280), 420),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-appearance-${stamp}@rakazo.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance-select");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "ui-appearance-dark-settings");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(26, 26, 26)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-dark");
});

test("sidebar bot rows use the sidebar hover tone", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-hover-${stamp}@rakazo.test`, "password12", "Hover QA");
  await completeOnboarding(page, testInfo);
  await createNamedBot(page, "Second Bot");

  const sidebar = page.locator("aside").first();
  const chief = sidebar.getByRole("button", { name: /^Chief/ }).first();
  await expect(chief).toBeVisible();
  const readChiefBg = () => chief.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(readChiefBg).toBe("rgba(0, 0, 0, 0)");

  await chief.hover();
  await expect.poll(readChiefBg).not.toBe("rgba(0, 0, 0, 0)");
  const chiefBg = await readChiefBg();
  await captureScreenshot(page, testInfo, "sidebar-row-hover");

  const integrations = sidebar.getByRole("button", { name: "Connect apps", exact: true });
  await integrations.hover();
  await expect
    .poll(() => integrations.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(chiefBg);
});

test("sidebar footer opens integrations and the account menu", async ({ page }, testInfo) => {
  await signup(page, `footer-web-${Date.now()}@rakazo.test`, "password12", "Footer Demo");
  await completeOnboarding(page);
  const footer = page.getByTestId("sidebar-footer");
  await expect(footer).toBeVisible();
  const searchBox = await page.getByTestId("sidebar-search").boundingBox();
  const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
  const pillBox = await footer
    .getByRole("button", { name: "Connect apps", exact: true })
    .boundingBox();
  expect(searchBox).toBeTruthy();
  expect(avatarBox).toBeTruthy();
  expect(pillBox).toBeTruthy();
  if (searchBox && avatarBox && pillBox) {
    expect(avatarBox.x).toBe(searchBox.x);
    expect(pillBox.x + pillBox.width).toBe(searchBox.x + searchBox.width);
    expect(pillBox.height).toBe(avatarBox.height);
  }
  await expect(footer.getByRole("button", { name: "Install update", exact: true })).toHaveCount(0);
  await footer.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close integrations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("link", { name: "Get the mobile app", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "sidebar-footer-menu");
  await page.keyboard.press("Escape");
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(footer).not.toBeInViewport();
  await page.getByTestId("restore-bots-sidebar").click();
  await expect(footer).toBeInViewport();
});

test("sidebar footer keeps the account identity readable and installs a ready desktop update", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const state = {
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      percent: 100,
      message: null,
      checkedAt: null,
    };
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => state,
          check: async () => state,
          download: async () => state,
          install: async () => {
            document.documentElement.dataset.updateInstalled = String(
              Number(document.documentElement.dataset.updateInstalled ?? 0) + 1,
            );
            return state;
          },
        },
      },
    });
  });
  const email = `footer-${Date.now()}@rakazo.test`;
  await signup(page, email, "password12", "Footer Demo");
  await completeOnboarding(page);
  const footer = page.getByTestId("sidebar-footer");
  const avatar = page.getByTestId("user-menu-trigger");
  const session = await (await page.request.get("/api/auth/get-session")).json();
  await expect(avatar).toHaveAccessibleName(`Account menu for ${session.user.name}`);
  await expect(footer.getByRole("button", { name: "Install update", exact: true })).toBeVisible();
  // Dismiss the existing update toast so the two footer frames stay focused.
  await page
    .getByRole("complementary", { name: "Desktop update" })
    .getByRole("button", { name: "Later" })
    .click();
  await avatar.click();
  const header = page.getByTestId("account-menu-header");
  await expect(header).toHaveText(`${session.user.name}${email}`);
  await expect(page.getByText("New update available", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "sidebar-footer-menu-update");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-installed", "1");
  await page.keyboard.press("Escape");
  await footer.getByRole("button", { name: "Install update", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-installed", "2");
});

test("account menu works on the mobile sidebar", async ({ page }) => {
  const email = `footer-mobile-${Date.now()}@rakazo.test`;
  await page.setViewportSize({ width: 390, height: 844 });
  await signup(page, email, "password12", "Mobile Demo");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const avatar = page.getByTestId("user-menu-trigger");
  await expect(avatar).toBeVisible();
  await expect(page.getByRole("button", { name: "Install update", exact: true })).toHaveCount(0);
  await avatar.click();
  const session = await (await page.request.get("/api/auth/get-session")).json();
  await expect(page.getByTestId("account-menu-header")).toHaveText(`${session.user.name}${email}`);
});
