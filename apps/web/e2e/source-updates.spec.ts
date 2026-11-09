import { expect, test } from "@playwright/test";
import type { SourceUpdatePreview, SourceUpdateRun } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("the owner can review and install a prepared source update", async ({ page }, testInfo) => {
  const currentCommit = "a".repeat(40);
  const targetCommit = "b".repeat(40);
  const forkCommit = "c".repeat(40);
  const summary = "Routine history shows when a scheduled run was delayed.";
  const preview: SourceUpdatePreview = {
    status: "available",
    reason: null,
    currentCommit,
    targetCommit,
    forkCommit,
    branch: "main",
    changedPaths: [],
    conflictingPaths: [],
    commits: [{ commit: targetCommit, subject: "Show delayed routine runs" }],
    commitCount: 1,
    changedFiles: ["apps/web/src/pages/RoutineHistory.tsx"],
    fileCount: 1,
    summary,
    summaryAvailable: true,
  };
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, json: { ...body.json, canManageSourceUpdates: true } },
    });
  });
  await page.route("**/rpc/sourceUpdates/state", (route) =>
    route.fulfill({ json: { json: { running: false, lastRun: null } } }),
  );
  await page.route("**/rpc/sourceUpdates/check", (route) =>
    route.fulfill({ json: { json: preview } }),
  );
  await page.route("**/rpc/sourceUpdates/apply", async (route) => {
    const now = new Date().toISOString();
    const run: SourceUpdateRun = {
      startedAt: now,
      finishedAt: now,
      ok: true,
      currentCommit,
      targetCommit,
      forkCommit,
      stage: "health",
      error: null,
      recovery: null,
    };
    await route.fulfill({ json: { json: run } });
  });
  await signup(page, `source-updates-${Date.now()}@rakazo.test`, "password12", "Update Tester");
  await completeOnboarding(page);
  await openUserSettings(page, "updates");
  const settings = page.getByTestId("source-update-settings");
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings.getByText(summary)).toBeVisible();
  await expect(settings.getByText("Update ready from your branch.")).toBeVisible();
  await captureScreenshot(page, testInfo, "source-update-ready");
  const applying = page.waitForRequest("**/rpc/sourceUpdates/apply");
  await settings.getByRole("button", { name: "Install update" }).click();
  expect((await applying).postDataJSON().json).toEqual({ currentCommit, targetCommit, forkCommit });
  await expect(settings.getByText("Update complete.")).toBeVisible();
});
