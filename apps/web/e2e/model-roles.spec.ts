import { expect, test } from "@playwright/test";
import type { ModelCatalogEntry, ModelRoleSettings } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("approval models reuse connections and persist independent backups", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `model-roles-${Date.now()}@rakazo.test`, "password12", "Model roles");
  await completeOnboarding(page);
  const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
  const main = catalog.find((entry) => entry.provider === "openrouter" && !entry.placeholder)!;
  await rpc(page, "models/connect", {
    provider: "openrouter",
    apiKey: "fake-role-api-key",
    modelId: main.id,
  });
  const original = await rpc<ModelRoleSettings>(page, "models/role", { role: "main" });
  await page.reload();
  await openUserSettings(page, "models");
  await page.getByText("Approval model", { exact: true }).click();
  const approval = page.getByTestId("model-role-approval");
  await approval.getByRole("combobox", { name: "Approval model", exact: true }).click();
  await page.locator('input[aria-label="Search models"]').fill("Jev 1.14");
  await page.getByRole("option", { name: "Jev 1.14", exact: true }).click();
  await expect(
    approval.getByRole("combobox", { name: "Approval model", exact: true }),
  ).toContainText("Jev 1.14");
  await expect
    .poll(
      async () =>
        (await rpc<ModelRoleSettings>(page, "models/role", { role: "approval" })).primary?.modelId,
    )
    .toBe("typesafe/jev-1.14");
  await approval.getByRole("combobox", { name: "Add backup model" }).click();
  await page.locator('input[aria-label="Search models"]').fill(main.label);
  await page.getByRole("option").filter({ hasText: main.label }).first().click();
  await expect(approval.getByTestId("model-backup-1")).toContainText(main.label);
  expect(await rpc<ModelRoleSettings>(page, "models/role", { role: "main" })).toEqual(original);
  await approval.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "approval-model-with-backup");
  await page.screenshot({ path: "../../.context/model-roles.png", fullPage: true });
  await page.reload();
  await page.getByText("Approval model", { exact: true }).click();
  await expect(
    page
      .getByTestId("model-role-approval")
      .getByRole("combobox", { name: "Approval model", exact: true }),
  ).toContainText("Jev 1.14");
  await expect(page.getByTestId("model-role-approval").getByTestId("model-backup-1")).toContainText(
    main.label,
  );
});
