// @vitest-environment jsdom

import type { SourceUpdatePreview, SourceUpdateRun, SourceUpdateState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { sourceState, sourceCheck, sourceApply } = vi.hoisted(() => ({
  sourceState: vi.fn<() => Promise<SourceUpdateState>>(),
  sourceCheck: vi.fn<() => Promise<SourceUpdatePreview>>(),
  sourceApply:
    vi.fn<(input: { currentCommit: string; targetCommit: string }) => Promise<SourceUpdateRun>>(),
}));

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace("#", String(count)),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SectionHeading: ({ children, ...props }: React.ComponentProps<"h3">) => (
    <h3 {...props}>{children}</h3>
  ),
}));

vi.mock("../lib/query/rpc", () => ({
  rpc: {
    sourceUpdates: {
      state: sourceState,
      check: sourceCheck,
      apply: sourceApply,
    },
  },
}));

import { SourceUpdates } from "./SourceUpdates";

const currentCommit = "a".repeat(40);
const targetCommit = "b".repeat(40);
const preview: SourceUpdatePreview = {
  status: "available",
  reason: null,
  currentCommit,
  targetCommit,
  branch: "main",
  changedPaths: ["apps/api/src/service.ts"],
  conflictingPaths: [],
  commits: [{ commit: targetCommit, subject: "Add an update preview" }],
  commitCount: 1,
  changedFiles: ["apps/api/src/service.ts"],
  fileCount: 1,
  summary: "Official changes add a safer update preview.",
  summaryAvailable: true,
};

function findButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reviews the preview and refreshes status after an uncertain update start", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const idle: SourceUpdateState = { running: false, lastRun: null };
  const running: SourceUpdateState = {
    running: true,
    lastRun: {
      startedAt: "2026-11-04T12:00:00.000Z",
      finishedAt: null,
      ok: false,
      currentCommit,
      targetCommit,
      stage: "restarting",
      error: null,
      recovery: null,
    },
  };
  sourceState
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(idle)
    .mockResolvedValue(running);
  sourceCheck.mockResolvedValue(preview);
  sourceApply.mockRejectedValue(new Error("API restarted before the response arrived"));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SourceUpdates />);
    });
    await act(async () => {
      findButton(container, "Check for updates").click();
    });

    expect(container.textContent).toContain("Official changes add a safer update preview.");
    await act(async () => {
      container.querySelector("summary")?.click();
    });
    expect(container.textContent).toContain("Add an update preview");
    expect(container.textContent).toContain("apps/api/src/service.ts");

    await act(async () => {
      findButton(container, "Install update").click();
    });
    expect(sourceApply).toHaveBeenCalledWith({ currentCommit, targetCommit });
    expect(container.textContent).toContain("Update status is unconfirmed.");
    expect(container.textContent).not.toContain("Update complete.");

    await act(async () => {
      findButton(container, "Refresh status").click();
    });
    expect(sourceState).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Installing update…");
    expect(container.textContent).not.toContain("Update status is unconfirmed.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps the apply state while its request is pending without polling", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const idle: SourceUpdateState = { running: false, lastRun: null };
  sourceState.mockResolvedValue(idle);
  sourceCheck.mockResolvedValue(preview);
  sourceApply.mockImplementation(() => new Promise<SourceUpdateRun>(() => undefined));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SourceUpdates />);
    });
    await act(async () => {
      findButton(container, "Check for updates").click();
    });
    await act(async () => {
      findButton(container, "Install update").click();
    });
    expect(container.textContent).toContain("Applying the reviewed update…");

    await act(async () => {
      await Promise.resolve();
    });
    expect(sourceState).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Applying the reviewed update…");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows the update summary while conflicts keep installation blocked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sourceState.mockResolvedValue({ running: false, lastRun: null });
  sourceCheck.mockResolvedValue({
    ...preview,
    status: "conflict",
    reason: "The official changes conflict with this checkout.",
    conflictingPaths: ["apps/api/src/service.ts"],
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SourceUpdates />));
    await act(async () => findButton(container, "Check for updates").click());

    expect(container.textContent).toContain(preview.summary);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The official changes conflict with this checkout.",
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Install update",
      ),
    ).toBe(false);
    expect(sourceApply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows recent changes directly when the model cannot summarize", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const idle: SourceUpdateState = { running: false, lastRun: null };
  sourceState.mockResolvedValue(idle);
  sourceCheck.mockResolvedValue({
    ...preview,
    summary: null,
    summaryAvailable: false,
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SourceUpdates />);
    });
    await act(async () => {
      findButton(container, "Check for updates").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("ul > li")?.textContent).toBe("Add an update preview");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
