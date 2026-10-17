// @vitest-environment jsdom
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  pathname: "/env/thread",
  terminalFocus: false,
  paletteOpen: false,
  navigate: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.keybindings }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; href: string }) => unknown;
  }) => select({ pathname: state.pathname, href: state.pathname }),
}));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../lib/terminalFocus", () => ({ isTerminalFocused: () => state.terminalFocus }));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => state.paletteOpen }));

import { MainAppLocationTracker } from "./mainAppLocation";
import { SidebarViewShortcuts, useSidebarViewPaletteItems } from "./sidebarViewCommands";

function Harness() {
  const items = useSidebarViewPaletteItems();
  return (
    <>
      <MainAppLocationTracker />
      <SidebarViewShortcuts />
      {items.map((item) => (
        <button key={item.value} onClick={item.run}>
          {item.title}
        </button>
      ))}
    </>
  );
}

let renderer: ReactTestRenderer;
const storageKey = "t3code:sidebar:view";

function press(overrides: KeyboardEventInit = {}, target: HTMLElement = document.body) {
  const event = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    metaKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("desktopBridge", undefined);
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  state.keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  state.pathname = "/env/thread";
  state.terminalFocus = false;
  state.paletteOpen = false;
  state.navigate.mockReset();
  localStorage.clear();
});

afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("sidebar view commands", () => {
  it.each(["MacIntel", "Linux"])("opens Home without leaving the thread on %s", (platform) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    localStorage.setItem(storageKey, JSON.stringify("pipeline"));
    act(() => {
      renderer = create(<Harness />);
    });

    const event = press({
      key: platform === "MacIntel" ? "¡" : "1",
      metaKey: platform === "MacIntel",
      ctrlKey: platform === "Linux",
    });

    expect(event.defaultPrevented).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify("home"));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("returns from Settings to the last thread like the rail", () => {
    act(() => {
      renderer = create(<Harness />);
    });
    state.pathname = "/settings/keybindings";
    act(() => renderer.update(<Harness />));

    press();

    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/env/thread" });
  });

  it("opens Home from the palette on a utility page", async () => {
    act(() => {
      renderer = create(<Harness />);
    });
    state.pathname = "/usage";
    act(() => renderer.update(<Harness />));

    await act(async () => renderer.root.findByType("button").props.onClick());

    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify("home"));
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/env/thread" });
  });

  it("uses the configured shortcut instead of the default", () => {
    state.keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key: "mod+alt+g", command: "sidebar.home", when: "!terminalFocus" },
      ]),
    );
    act(() => {
      renderer = create(<Harness />);
    });

    expect(press().defaultPrevented).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(press({ key: "g", code: "KeyG" }).defaultPrevented).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify("home"));
  });

  it("handles Home forwarded from Electron's focused browser and unsubscribes", () => {
    let menuAction: ((command: string) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("desktopBridge", {
      onMenuAction: (listener: typeof menuAction) => {
        menuAction = listener;
        return unsubscribe;
      },
    });
    act(() => {
      renderer = create(<Harness />);
    });

    act(() => menuAction?.("sidebar.home"));

    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify("home"));
    act(() => renderer.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("leaves terminal input, palette input, repeats and shortcut capture alone", () => {
    act(() => {
      renderer = create(<Harness />);
    });
    state.terminalFocus = true;
    expect(press().defaultPrevented).toBe(false);
    state.terminalFocus = false;
    state.paletteOpen = true;
    expect(press().defaultPrevented).toBe(false);
    state.paletteOpen = false;
    expect(press({ repeat: true }).defaultPrevented).toBe(false);
    const input = document.createElement("input");
    input.setAttribute("data-keybinding-capture", "");
    document.body.append(input);
    expect(press({}, input).defaultPrevented).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
