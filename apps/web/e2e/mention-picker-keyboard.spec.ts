import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  signup,
} from "./helpers";

async function createBot(page: Page, name: string) {
  return createNamedBot(page, name);
}

test("mention picker completes with Enter and Tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mention-keys-${stamp}@rakazo.test`, "password12", "Mention Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");
  expect(researcherId).toBeTruthy();
  expect(writerId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Mention keys team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("checkbox", { name: "Add Researcher to the group" }).click();
  await panel.getByRole("checkbox", { name: "Add Research Writer to the group" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Mention keys team" });
  await composer.fill("@Res");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-open");

  await composer.press("ArrowDown");
  await expect(picker.getByRole("option", { name: "@Research Writer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await composer.press("Enter");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-completed");

  await page.getByRole("button", { name: "Remove mention Research Writer" }).click();
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Tab");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "Remove mention Researcher" }).click();
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Res");
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toBeFocused();

  for (const method of ["Enter", "Tab", "pointer"]) {
    const text = "i need u to message @Res and do this";
    await composer.fill(text);
    await composer.evaluate((element, caret) => {
      const field = element as HTMLTextAreaElement;
      field.setSelectionRange(caret, caret);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    }, text.indexOf(" and"));
    await expect(picker).toBeVisible();
    if (method === "pointer")
      await picker.getByRole("option", { name: "@Researcher", exact: true }).click();
    else await composer.press(method);
    await expect(composer).toHaveValue("i need u to message @Researcher and do this");
    await expect(composer).toBeFocused();
    await composer.pressSequentially("also ");
    await expect(composer).toHaveValue("i need u to message @Researcher also and do this");
    await captureScreenshot(page, testInfo, `inline-mention-${method.toLowerCase()}`);
  }
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText(
    "i need u to message @Researcher also and do this",
  );

  await composer.fill("hello without a picker");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("hello without a picker", {
    timeout: 60_000,
  });
});
