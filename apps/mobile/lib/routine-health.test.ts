import { expect, it } from "vitest";

import { routineHealthLines } from "./routine-health";

it("shows a delay and the last attempt separately from the last successful run", () => {
  const lines = routineHealthLines(
    {
      nextRunAt: "2026-11-01T06:00:00Z",
      delayed: true,
      lastAttempt: { at: "2026-11-01T05:00:00Z", status: "failed" },
      lastSuccessAt: "2026-10-31T05:00:00Z",
      delayAlertsEnabled: false,
      failureAlertsEnabled: true,
      delayAlertResult: null,
    },
    "en-US",
  );
  expect(lines.join(" ")).toContain("Schedule delayed");
  expect(lines.join(" ")).toContain("Last attempt");
  expect(lines.join(" ")).toContain("Last successful run");
  expect(lines.join(" ")).not.toContain("Delivered");
});
