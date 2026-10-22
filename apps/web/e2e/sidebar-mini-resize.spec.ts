import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("sidebar rail keeps chats interactive and remembers a dragged width", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `sidebar-rail-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Research",
    title: "Field notes",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "threads/markUnread", { botId: bot.id });
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
  await expect(sidebar).toHaveCSS("width", "316px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const edge = (await handle.boundingBox())!;
  await page.mouse.down();
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await page.mouse.move(edge.x + 88, edge.y + 300, { steps: 10 });
  await expect(sidebar).toHaveCSS("width", "400px");
  await page.mouse.up();
  const preferredWidth = Math.round((await sidebar.boundingBox())!.width);
  expect(preferredWidth).toBeGreaterThan(390);
  await expect(handle).toHaveAttribute("aria-valuenow", String(preferredWidth));
  await captureScreenshot(page, testInfo, "sidebar-resized-expanded");

  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(sidebar).toHaveCSS("width", "80px");
  await expect(row).toHaveAccessibleName("Research");
  await expect(row).toHaveAccessibleDescription(/unread/);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/${bot.id}$`));
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator("[data-roster-preview]")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-mini-avatar-rail");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "80px");
  await page.getByTestId("restore-bots-sidebar").click();
  await expect(sidebar).toHaveCSS("width", `${preferredWidth}px`);

  await handle.focus();
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "80px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const miniEdge = (await handle.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(miniEdge.x + 240, miniEdge.y + 300, { steps: 12 });
  await page.mouse.up();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBeGreaterThan(300);

  await page.getByTestId("minimize-bots-sidebar").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "316px");
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toBeVisible();
  await expect(row.locator("[data-roster-bot-name]")).toBeVisible();
});

test("sidebar resize follows RTL and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page, `sidebar-rtl-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  // A viewport change renders the logical sidebar side after changing document direction.
  await page.setViewportSize({ width: 1300, height: 900 });
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "348px");
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "80px");
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "240px");
  const box = (await sidebar.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(1300);
});
