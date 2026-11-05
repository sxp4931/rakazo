import { describe, expect, it, vi } from "vitest";
import { createSourceUpdaterApp } from "./source-service.js";

describe("source updater service", () => {
  it("protects source endpoints with its dedicated bearer token", async () => {
    const updater = {
      state: () => ({ running: false, lastRun: null }),
      check: vi.fn(async () => ({ status: "up-to-date" })),
      apply: vi.fn(async () => ({ ok: true })),
    };
    const app = createSourceUpdaterApp(
      {
        deployDir: "/opt/rakazo",
        statePath: "/opt/rakazo/.state/source-update-state.json",
        backupDir: "/var/lib/rakazo/source-update-backups",
        token: "dedicated-token",
      },
      { updater: updater as never },
    ).app;

    expect((await app.request("/source/state")).status).toBe(401);
    const state = await app.request("/source/state", {
      headers: { authorization: "Bearer dedicated-token" },
    });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ running: false, lastRun: null });
  });
});
