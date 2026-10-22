import { expect, test } from "@playwright/test";
import { captureScreenshot, chooseOption, signup } from "./helpers";

test("new hosted users can answer or skip the signup survey before their first chat", async ({
  page,
}, testInfo) => {
  // Local and CI servers do not bill, so stand in for the hosted service's flag.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsSignupSurvey: true } } });
  });
  const submitted: unknown[] = [];
  await page.route("**/rpc/onboarding/signupSurvey", async (route) => {
    submitted.push((route.request().postDataJSON() as { json: unknown }).json);
    await route.fulfill({ json: { json: { ok: true } } });
  });

  await signup(page, `survey-${Date.now()}@rakazo.test`, "password12", "Survey");

  await expect(page.getByRole("heading", { name: "Welcome to Rakazo" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "How big is your team?" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "01-signup-survey");

  await page.getByLabel("What are you hoping to use Rakazo for?").fill("  Keep my inbox at zero ");
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await chooseOption(page.getByRole("combobox", { name: "How big is your team?" }), "11–50");
  await page.getByLabel("How did you hear about us?").fill("A friend");
  await captureScreenshot(page, testInfo, "02-signup-survey-work");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  expect(submitted).toEqual([
    { reason: "Keep my inbox at zero", use: "work", teamSize: "11-50", source: "A friend" },
  ]);
});
