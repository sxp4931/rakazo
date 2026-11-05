import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("sending messages never prompts for a GitHub star", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `star-prompt-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });
  await page.evaluate(() => localStorage.setItem("rakazo.githubStarPrompt.sent", "5"));

  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill("What should I work on today?");
  await composer.press("Enter");

  const prompt = page.getByRole("complementary", { name: "Star on GitHub" });
  await expect(
    page.getByTestId("transcript").getByText("What should I work on today?"),
  ).toBeVisible();
  await expect(prompt).toBeHidden();
  await captureScreenshot(page, testInfo, "chat-without-star-prompt");
  await page.reload();
  await composer.fill("And tomorrow?");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript").getByText("And tomorrow?")).toBeVisible();
  await expect(prompt).toBeHidden();
});
