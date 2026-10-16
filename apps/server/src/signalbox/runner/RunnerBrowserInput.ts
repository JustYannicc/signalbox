import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

/**
 * A person's input to the tab they took over (#587), dispatched over the
 * tab's CDP session as upstream's viewer input is (`ServerBrowser.ts`
 * `dispatchViewerInput`). It remembers what is held down, so handing back
 * never leaves a key or button pressed in the agent's tab.
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

export interface InputDriver {
  readonly dispatch: (cdp: CDPSession, input: AgentBrowserDrivingInput) => Promise<void>;
  /** Lets go of every key and button still held down. */
  readonly release: (cdp: CDPSession) => Promise<void>;
}

export const makeInputDriver = (): InputDriver => {
  const keys = new Map<string, { key: string; code: string }>();
  const buttons = new Map<Button, { x: number; y: number }>();

  const dispatch = async (cdp: CDPSession, input: AgentBrowserDrivingInput) => {
    switch (input._tag) {
      case "mouse": {
        const type =
          input.action === "down"
            ? "mousePressed"
            : input.action === "up"
              ? "mouseReleased"
              : "mouseMoved";
        const point = { x: finite(input.x), y: finite(input.y) };
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
      case "wheel":
        return cdp
          .send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: finite(input.x),
            y: finite(input.y),
            deltaX: finite(input.deltaX),
            deltaY: finite(input.deltaY),
            modifiers: modifiersOf(input.modifiers),
          })
          .then(constVoid);
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
