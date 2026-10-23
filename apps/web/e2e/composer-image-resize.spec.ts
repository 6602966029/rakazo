import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("large composer images are resized before artifact upload", async ({ page }, testInfo) => {
  await signup(page, `image-resize-${Date.now()}@rakazo.test`, "password12", "Image Test");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();

  // Generate a real image in the browser so decoding and canvas encoding are exercised.
  const original = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 3200;
    canvas.height = 2400;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 1).split(",")[1]!;
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "large-photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(original, "base64"),
  });
  await expect(page.getByRole("button", { name: "Remove large-photo.jpg" })).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-large-image");

  // No model call is needed to verify the upload boundary.
  await page.route("**/rpc/threads/send", (route) => route.abort());
  const upload = page.waitForRequest("**/rpc/artifacts/create");
  await composer.fill("Read this photo");
  await composer.press("Enter");
  const { name, mimeType, contentBase64 } = (await upload).postDataJSON().json;
  expect(name).toBe("large-photo.jpg");
  expect(mimeType).toBe("image/jpeg");
  expect(contentBase64.length).toBeLessThan(original.length);
  const dimensions = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, contentBase64);
  expect(dimensions).toEqual([1600, 1200]);
});
