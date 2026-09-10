import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachMobileTrackpad,
  isTouchBrowser,
  mobileInputChanges,
} from "../../computer/mobile-keyboard.js";

describe("mobile computer keyboard", () => {
  it("translates inserted and deleted text", () => {
    expect(mobileInputChanges("___", "___a", 4)).toEqual({
      backspaces: 0,
      text: "a",
    });
    expect(mobileInputChanges("___a", "___", 3)).toEqual({
      backspaces: 1,
      text: "",
    });
  });

  it("replaces corrected text instead of duplicating it", () => {
    expect(mobileInputChanges("___teh", "___the", 6)).toEqual({
      backspaces: 2,
      text: "he",
    });
  });

  it("only enables the control in touch browsers", () => {
    expect(isTouchBrowser({ maxTouchPoints: 1 }, {})).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, { ontouchstart: null })).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, {})).toBe(false);
  });

  it("enables a visible relative-pointer mode", () => {
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    const button = {
      hidden: true,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: () => {},
      setAttribute: () => {},
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
    };
    const surface = {
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      classList: { toggle: () => {}, remove: () => {} },
    };
    const rfb = { viewOnly: false, showDotCursor: false };
    const detach = attachMobileTrackpad(rfb, { button, surface, documentTarget: {} });
    listeners.get("click")?.();
    expect(button.hidden).toBe(false);
    expect(rfb.showDotCursor).toBe(true);
    expect(classes.has("active")).toBe(true);
    detach();
    expect(rfb.showDotCursor).toBe(false);
  });

  it("ships and initializes the keyboard bridge in the computer image", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const embed = readFileSync(path.join(root, "embed.html"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const supervisor = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
    expect(dockerfile).toMatch(/mobile-keyboard\.js/);
    expect(embed).toMatch(/attachMobileKeyboard/);
    expect(embed).toMatch(/mobile-keyboard-input/);
    expect(embed).toMatch(/attachMobileTrackpad/);
    expect(embed).toMatch(/mobile-trackpad/);
    expect(embed).toMatch(/mobile-keyboard-open #screen/);
    expect(embed).toMatch(/--mobile-visual-height/);
    expect(start).toMatch(/mobile-keyboard\.js/);
    expect(supervisor).toMatch(/"mobile-keyboard\.js"/);
  });
});
