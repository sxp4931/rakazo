// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const health = vi.hoisted(() => vi.fn());
const setAlerts = vi.hoisted(() => vi.fn());
vi.mock("../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/query/query")>()),
  useSpaceQueries: () => ({
    routines: {
      health: {
        queryOptions: ({ input }: { input: { routineId: string } }) => ({
          queryKey: [["user:user-1", "space:space-1", "routines", "health"], { input }],
          queryFn: () => health(input),
        }),
      },
    },
  }),
  useSave: ({ save }: { save: (input: unknown, client: unknown) => Promise<unknown> }) => ({
    pending: false,
    error: null,
    run: (input: unknown) => save(input, { routines: { setAlerts } }),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Switch: ({
    "aria-label": label,
    checked,
    onCheckedChange,
  }: {
    "aria-label": string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => <button type="button" aria-label={label} onClick={() => onCheckedChange(!checked)} />,
}));
vi.mock("./space/ActivityList", () => ({
  statusLabel: (status: string) => (status === "failed" ? "Failed" : status),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { spaceChanged } from "../lib/query/space-changes";
import { RoutineHealth } from "./RoutineHealth";

it("shows routine health and refreshes on routine and run signals", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  health.mockResolvedValue({
    nextRunAt: "2026-11-01T06:00:00Z",
    delayed: true,
    lastAttempt: { at: "2026-11-01T05:00:00Z", status: "failed" },
    lastSuccessAt: "2026-10-31T05:01:00Z",
    delayAlertsEnabled: false,
    failureAlertsEnabled: true,
    delayAlertResult: null,
  });
  setAlerts.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RoutineHealth routineId="routine-1" />
        </QueryClientProvider>,
      ),
    );
    await act(async () =>
      vi.waitFor(() => expect(container.textContent).toContain("Schedule delayed")),
    );
    expect(container.textContent).toContain("Last attempt");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Last successful run");
    expect(container.textContent).not.toContain("Delivered");
    await act(async () => {
      await spaceChanged("runs", client);
      await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(2));
    });
    await act(async () => {
      await spaceChanged("routines", client);
      await vi.waitFor(() => expect(health).toHaveBeenCalledTimes(3));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Delay alerts"]')!.click(),
    );
    expect(setAlerts).toHaveBeenCalledWith({ routineId: "routine-1", delayed: true });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
