import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

// Tall enough that each scenario's transcript fits without scrolling inside the chat pane.
test.use({ viewport: { width: 1280, height: 2200 } });

test("gallery renders every chat scenario in both themes", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/fixtures/gallery.html?theme=light");
  const nav = page.getByRole("navigation");
  const scenarios = await nav.locator("button:not([aria-pressed])").all();
  expect(scenarios.length).toBeGreaterThan(5);

  for (const scenario of scenarios) {
    const label = (await scenario.textContent())!;
    await scenario.click();
    await expect(scenario).toHaveAttribute("aria-current", "page");
    for (const theme of ["light", "dark"]) {
      const dark = nav.getByRole("button", { name: "Dark" });
      if ((await dark.getAttribute("aria-pressed")) !== String(theme === "dark"))
        await dark.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("gallery-frame")).not.toBeEmpty();
      await captureScreenshot(
        page,
        testInfo,
        `gallery-${label.toLowerCase().replaceAll(" ", "-")}-${theme}`,
      );
    }
  }

  await nav.getByRole("button", { name: "Phone width" }).click();
  await nav.getByRole("button", { name: "Questions" }).click();
  await captureScreenshot(page, testInfo, "gallery-questions-phone");
  expect(errors).toEqual([]);
});
