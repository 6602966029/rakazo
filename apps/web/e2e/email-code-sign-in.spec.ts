import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

async function mockEmailCode(page: Page) {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        sso: null,
        passwordAuth: true,
        passwordReset: true,
        resetUrl: "http://127.0.0.1/reset-password",
        billing: false,
        emailCode: true,
      },
    }),
  );
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
}

for (const { path, name } of [
  { path: "/sign-in", name: "auth-email-code" },
  { path: "/sign-up", name: "auth-email-code-sign-up" },
]) {
  test(`${path} sends an email code before asking for it`, async ({ page }, testInfo) => {
    await mockEmailCode(page);
    await page.goto(path);
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use password" })).toBeVisible();
    await page.getByLabel("Email").fill("person@example.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Code" })).toBeFocused();
    await captureScreenshot(page, testInfo, name);
  });
}
