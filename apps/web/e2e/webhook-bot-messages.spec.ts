import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("webhook bot messaging is opt-in, persists, and can be revoked", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `webhook-permission-${Date.now()}@rakazo.test`,
    "password12",
    "Webhook permission",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "bots/rotateWebhookSecret", { botId });
  await page.reload();

  const openSettings = async () => {
    await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
    const settings = page.getByTestId("bot-settings");
    await settings.getByText("Advanced", { exact: true }).click();
    return settings.getByRole("switch", { name: "Allow webhook messages to other bots" });
  };
  const toggle = await openSettings();
  await expect(toggle).not.toBeChecked();
  const save = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await toggle.click();
  await save;
  await expect(toggle).toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "webhook-bot-messages-enabled");

  await page.reload();
  const reloaded = await openSettings();
  await expect(reloaded).toBeChecked();
  const revoke = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await reloaded.click();
  await revoke;
  expect((await rpc<Bot>(page, "bots/get", { botId })).webhookAllowBotMessages).toBe(false);
});
