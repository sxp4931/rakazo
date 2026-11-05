// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  os: "ios",
}));

vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/native", () => ({
  native: { fill: "fill" },
  useMobileTokens: () => ({ foreground: "foreground", mutedForeground: "muted", card: "card" }),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("react-native", () => {
  const wrap = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Alert: { prompt: mocks.prompt },
    Modal: wrap,
    Platform: {
      get OS() {
        return mocks.os;
      },
    },
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    Text: wrap,
    TextInput: () => null,
    View: wrap,
  };
});

import { ProfileEditDialog } from "../components/profile-edit-dialog";

it("preserves surrounding spaces when correcting a memory entry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onCommit = vi.fn(async (_value: string) => undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ProfileEditDialog
          value="old"
          label="Edit memory"
          editLabel="Edit old"
          maxLength={100}
          preserveWhitespace
          onCommit={onCommit}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    const buttons = mocks.prompt.mock.lastCall?.[2] as
      | [{ text: string }, { onPress?: (value?: string) => void }]
      | undefined;
    await act(async () => buttons?.[1].onPress?.("  corrected  "));
    expect(onCommit).toHaveBeenCalledWith("  corrected  ");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
