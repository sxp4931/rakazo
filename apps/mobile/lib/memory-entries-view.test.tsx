// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const saveHook = vi.hoisted(() => vi.fn());
const screenQuery = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(() => (parts: TemplateStringsArray) => parts.join(""));
vi.mock("../lib/query/query", () => ({
  rpcQuery: (procedure: string, input: unknown) => ({ queryKey: [procedure, input] }),
  useSave: (options: unknown) => saveHook(options),
  refreshRpcQueries: vi.fn(async () => undefined),
}));
vi.mock("../lib/query/screen-query", () => ({
  useScreenQuery: (read: unknown, options: unknown) => screenQuery(read, options),
}));
vi.mock("../lib/native/native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../lib/api/user-error", () => ({ errorText: () => "Error" }));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: translate }) }));
vi.mock("react-native", () => {
  const wrap = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Alert: { alert: vi.fn() }, Modal: wrap, ScrollView: wrap, Text: wrap, View: wrap };
});
vi.mock("../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/bots/profile-edit-dialog", () => ({
  ProfileEditDialog: ({ value, onCommit }: { value: string; onCommit: (next: string) => void }) => (
    <button type="button" onClick={() => onCommit("corrected")}>
      {value}
    </button>
  ),
}));

import { MemoryEntries } from "../components/memory-entries";

function renderSave() {
  saveHook.mockImplementation((options: unknown) => {
    if (!options || typeof options !== "object" || !("save" in options)) return {};
    return {
      run(input: unknown) {
        const save = options.save;
        if (typeof save !== "function") return;
        void Promise.resolve(
          save(input, (procedure: string, body: unknown) => rpc(procedure, body)),
        ).then(
          (saved: unknown) => {
            if ("onSaved" in options && typeof options.onSaved === "function")
              options.onSaved(saved, input);
          },
          (error: Error) => {
            if ("onFailed" in options && typeof options.onFailed === "function")
              options.onFailed(error, input);
          },
        );
      },
      pending: false,
      error: null,
      reset: vi.fn(),
    };
  });
}

it("loads prompt memory after the user asks to view it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  screenQuery.mockImplementation((_read, options: { enabled: boolean }) => ({
    data: options.enabled ? { text: "shared fact", usedBytes: 11, limitBytes: 32768 } : undefined,
    error: null,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }));
  renderSave();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryEntries initial={null} botId="bot" onClose={() => {}} onUpdate={() => {}} />,
      ),
    );
    expect(container.textContent).not.toContain("shared fact");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "View prompt memory")!
        .click(),
    );
    expect(screenQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryKey: ["memory/prompt", { botId: "bot" }] }),
      expect.objectContaining({ enabled: true }),
    );
    expect(container.textContent).toContain("shared fact");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("edits one occurrence and undoes only its saved revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const initial = {
    id: "doc",
    scope: "bot" as const,
    botId: "bot",
    path: "MEMORY.md",
    content: "same\nsame",
    revision: 1,
    updatedAt: "",
  };
  rpc.mockImplementation(async (method: string) =>
    method === "memory/editEntry"
      ? { ...initial, content: "same\ncorrected", revision: 2 }
      : { ...initial, revision: 3 },
  );
  renderSave();
  screenQuery.mockReturnValue({ data: undefined, error: null, isError: false, isFetching: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryEntries initial={initial} botId="bot" onClose={() => {}} onUpdate={() => {}} />,
      ),
    );
    await act(async () => {
      [...container.querySelectorAll("button")]
        .filter((button) => button.textContent === "same")[1]!
        .click();
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith("memory/editEntry", {
      documentId: "doc",
      expectedRevision: 1,
      start: 5,
      end: 9,
      expected: "same",
      replacement: "corrected",
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Undo")!
        .click();
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith("memory/undoEntry", {
      documentId: "doc",
      expectedRevision: 2,
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
