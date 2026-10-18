import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("voice settings connect a key, speak a reply, and open a call", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Voice ${stamp}`;
  await signup(page, `voice-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await expect(page.getByRole("button", { name: "Call", exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId("composer-bar").getByRole("button", { name: "Voice", exact: true }),
  ).toHaveCount(1);
  await captureScreenshot(page, testInfo, "voice-composer");
  await page
    .getByTestId("composer-bar")
    .getByRole("button", { name: "Voice", exact: true })
    .click();
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "voice-settings");
  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("voice-settings")).toHaveCount(0);

  const preparedOff = await rpc<{ ready: boolean }>(page, "voice/prepare", {
    text: "Hello there.",
  });
  expect(preparedOff.ready).toBe(false);

  await openUserSettings(page, "voice");
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await page.getByRole("button", { name: /Scripted/ }).click();
  const apiKeyInput = page.getByPlaceholder(/Paste your API key/);
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-voice-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-settings-connected");

  const spoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await page.getByRole("button", { name: "Hear a sample" }).click();
  const clip = await spoken;
  expect(clip.headers()["content-type"]).toContain("audio/mpeg");

  const credentials = await rpc<Array<{ hasKey: boolean; provider: string }>>(
    page,
    "voice/credentials",
    {},
  );
  expect(credentials).toEqual([expect.objectContaining({ hasKey: true, provider: "scripted" })]);
  expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

  await page.getByRole("button", { name: "Close voice settings" }).click();

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("say hello");
  await page.keyboard.press("Enter");
  // A reply can render more than one text bubble; speak the latest one.
  const speakReply = page.getByRole("button", { name: "Speak this reply" }).last();
  await expect(speakReply).toBeVisible({
    timeout: 30_000,
  });

  const replySpoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await speakReply.click();
  await replySpoken;

  await openUserSettings(page, "voice");
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close voice settings" }).click();

  await page
    .getByTestId("composer-bar")
    .getByRole("button", { name: "Voice", exact: true })
    .click();
  await expect(page.getByTestId("call-view")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up" })).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-call");
  await page.getByRole("button", { name: "Hang up" }).click();
  await expect(page.getByTestId("call-view")).toHaveCount(0);

  await openUserSettings(page, "voice");
  const settings = page.getByTestId("voice-settings");
  await settings.getByPlaceholder(/Paste a replacement key/).fill("leftover-voice-key");
  await settings.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(rpc<Array<{ provider: string }>>(page, "voice/credentials", {})).resolves.toEqual(
    [],
  );
});

test("voice settings list Mac voices when the server offers them", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `voice-mac-${stamp}@rakazo.test`, "password12", `Mac ${stamp}`);
  await completeOnboarding(page);
  await page.route("**/rpc/voice/catalog", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const voices = Array.isArray(body.json) ? body.json : [];
    if (!voices.some((entry) => entry.id === "macos")) {
      voices.unshift({
        id: "macos",
        name: "macOS",
        description: "Voices installed on the Mac running Rakazo.",
        transcribe: false,
      });
    }
    await route.fulfill({ response, json: { ...body, json: voices } });
  });
  await page.route("**/rpc/voice/voices", async (route) => {
    const request = route.request().postDataJSON() as { json?: { provider?: string } };
    if (request.json?.provider !== "macos") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        json: [
          { id: "macos:Zoe (Premium)", label: "Zoe (Premium)" },
          { id: "macos:Samantha", label: "Samantha" },
        ],
      },
    });
  });
  await openUserSettings(page, "voice");
  const settings = page.getByTestId("voice-settings");
  await settings.getByRole("button", { name: "macOS" }).click();
  await expect(settings.getByText("Free, works offline")).toBeVisible();
  await expect(
    settings.getByText("Uses the voices installed on this Mac. No API key."),
  ).toBeVisible();
  await expect(settings.getByRole("option", { name: "Zoe (Premium)" })).toBeAttached();
  await captureScreenshot(page, testInfo, "voice-macos");
});

test("bot settings list a Mac voice", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `voice-bot-${stamp}@rakazo.test`, "password12", `Bot ${stamp}`);
  await completeOnboarding(page);
  await page.route("**/rpc/voice/status", async (route) => {
    await route.fulfill({
      json: {
        json: { configured: true, ready: true, transcribe: false, provider: "macos", voiceId: "" },
      },
    });
  });
  await page.route("**/rpc/voice/voices", async (route) => {
    await route.fulfill({
      json: { json: [{ id: "macos:Zoe (Premium)", label: "Zoe (Premium)" }] },
    });
  });
  await page.route("**/rpc/bots/list", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const bots = Array.isArray(body.json) ? body.json : [];
    for (const bot of bots) {
      if (bot?.name === "Chief") {
        bot.macVoice = "Zoe (Premium)";
        bot.autoSpeak = true;
      }
    }
    await route.fulfill({ response, json: { ...body, json: bots } });
  });
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByText("Advanced", { exact: true }).click();
  await expect(settings.getByLabel("Voice")).toHaveValue("macos:Zoe (Premium)");
});
