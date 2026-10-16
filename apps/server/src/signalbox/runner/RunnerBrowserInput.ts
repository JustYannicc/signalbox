import type {
  AgentBrowserDrivingInput,
  AgentBrowserPointerTarget,
} from "@t3tools/contracts/signalboxPreviews";
import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

import type { NodeBox } from "./RunnerBrowserRecorder.ts";

/**
 * A person's input to the tab they took over (#587), dispatched over the
 * tab's CDP session as upstream's viewer input is (`ServerBrowser.ts`
 * `dispatchViewerInput`). It remembers what is held down, so handing back
 * never leaves a key or button pressed in the agent's tab.
 *
 * Pointer input aims at the element the person pointed at in the mirror
 * (`target`), at the same spot across its box here: the mirror lays the page
 * out with the viewer's fonts, so its coordinates can land on a neighbour.
 * The coordinates are the fallback when the element is gone or out of view.
 */

type Button = "left" | "middle" | "right";

const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/** Alt 1, Ctrl 2, Meta 4, Shift 8, as CDP takes them. */
const modifiersOf = (value: number) =>
  Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;

// Cmd shortcuts from Apple viewers are no editing shortcut for the Linux
// browser, so they carry the command, as upstream's viewer input does.
const editingCommand = (key: string, modifiers: number) => {
  if ((modifiers & 0b0111) !== 4) return {};
  const lower = key.toLowerCase();
  const command =
    lower === "a" ? "selectAll" : lower === "z" ? (modifiers & 8 ? "redo" : "undo") : null;
  return command === null ? {} : { commands: [command] };
};

/**
 * The spot `fx`, `fy` across `box`, kept inside the part of it in view; null
 * when none of it is.
 */
const pointIn = (
  box: NodeBox,
  fx: number,
  fy: number,
): { readonly x: number; readonly y: number } | null => {
  const along = (start: number, size: number, view: number, fraction: number) => {
    const from = Math.max(start, 0);
    const to = Math.min(start + size, view);
    if (!(to > from)) return null;
    // Half a pixel in from the edges, where a neighbour's box begins.
    const inset = Math.min(0.5, (to - from) / 2);
    const at = start + Math.min(Math.max(finite(fraction, 0.5), 0), 1) * size;
    return Math.min(Math.max(at, from + inset), to - inset);
  };
  const x = along(box.left, box.width, box.viewWidth, fx);
  const y = along(box.top, box.height, box.viewHeight, fy);
  return x === null || y === null ? null : { x, y };
};

/** Where rrweb's element `node` is in the tab's page now. */
export type LocateNode = (cdp: CDPSession, node: number) => Promise<NodeBox | null>;

export interface InputDriver {
  readonly dispatch: (cdp: CDPSession, input: AgentBrowserDrivingInput) => Promise<void>;
  /** Lets go of every key and button still held down. */
  readonly release: (cdp: CDPSession) => Promise<void>;
}

export const makeInputDriver = (locate?: LocateNode): InputDriver => {
  const keys = new Map<string, { key: string; code: string }>();
  const buttons = new Map<Button, { x: number; y: number }>();

  const aim = async (
    cdp: CDPSession,
    input: {
      readonly x: number;
      readonly y: number;
      readonly target?: AgentBrowserPointerTarget | undefined;
    },
  ) => {
    const fallback = { x: finite(input.x), y: finite(input.y) };
    if (input.target === undefined || locate === undefined) return fallback;
    const box = await locate(cdp, input.target.node).catch(() => null);
    return (box && pointIn(box, input.target.fx, input.target.fy)) ?? fallback;
  };

  const dispatch = async (cdp: CDPSession, input: AgentBrowserDrivingInput) => {
    switch (input._tag) {
      case "mouse": {
        const type =
          input.action === "down"
            ? "mousePressed"
            : input.action === "up"
              ? "mouseReleased"
              : "mouseMoved";
        const point = await aim(cdp, input);
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: input.button,
          buttons: finite(input.buttons),
          clickCount: finite(input.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers: modifiersOf(input.modifiers),
        });
        if (input.button === "none") return;
        if (input.action === "down") buttons.set(input.button, point);
        else if (input.action === "up") buttons.delete(input.button);
        return;
      }
      case "wheel": {
        const point = await aim(cdp, input);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          deltaX: finite(input.deltaX),
          deltaY: finite(input.deltaY),
          modifiers: modifiersOf(input.modifiers),
        });
        return;
      }
      case "key": {
        const { key, code, text } = input;
        const modifiers = modifiersOf(input.modifiers);
        if (input.action === "up") {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          keys.delete(code || key);
          return;
        }
        await cdp.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...editingCommand(key, modifiers),
          windowsVirtualKeyCode:
            input.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
        });
        keys.set(code || key, { key, code });
        return;
      }
      case "text":
        if (input.text.length === 0) return;
        return cdp.send("Input.insertText", { text: input.text.slice(0, 10_000) }).then(constVoid);
    }
  };

  const release = async (cdp: CDPSession) => {
    for (const { key, code } of keys.values())
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(constVoid);
    keys.clear();
    for (const [button, point] of buttons)
      await cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          ...point,
          buttons: 0,
          clickCount: 1,
        })
        .catch(constVoid);
    buttons.clear();
  };

  return { dispatch, release };
};
