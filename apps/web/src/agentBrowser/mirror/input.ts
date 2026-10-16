import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";

import { inputModifiers, keyText, wheelDeltaPx } from "./geometry";

type MouseInput = Extract<AgentBrowserDrivingInput, { _tag: "mouse" }>;
type WheelInput = Extract<AgentBrowserDrivingInput, { _tag: "wheel" }>;
type MouseButton = MouseInput["button"];

/** Kept in the keyboard field so soft keyboards have something to delete. */
const SENTINEL = "​";
const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;

const buttonOf = (button: number): MouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const pressedButtonOf = (buttons: number): MouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

export interface InputTarget {
  /** Takes pointers and wheels over the page. */
  readonly surface: HTMLElement;
  /** Focused while driving so key presses and soft keyboards land somewhere. */
  readonly keyboard: HTMLTextAreaElement;
  readonly enabled: () => boolean;
  readonly toPage: (
    clientX: number,
    clientY: number,
    clamp: boolean,
  ) => { readonly x: number; readonly y: number } | null;
  /** Frame pixels per page pixel. */
  readonly scale: () => number;
  readonly pageHeight: () => number;
  /** Whether the mirrored page has a field at this point, so a tap raises the keyboard. */
  readonly isEditableAt: (x: number, y: number) => boolean;
  readonly send: (input: AgentBrowserDrivingInput) => void;
}

/**
 * Turns the person's pointer, wheel, touch and keys over the mirror into the
 * agent browser's input, in the page's CSS pixels. Moves and wheels coalesce
 * to one per frame. Returns a detach function.
 */
export function attachInput(target: InputTarget): () => void {
  const { surface, keyboard, send } = target;
  let pendingMove: MouseInput | null = null;
  let pendingWheel: WheelInput | null = null;
  let frame: number | null = null;
  let heldButtons = 0;
  const clicks: Record<MouseButton, number> = { none: 0, left: 0, middle: 0, right: 0 };
  let lastClick: { button: MouseButton; time: number; x: number; y: number; count: number } | null =
    null;
  let touch: {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    panning: boolean;
  } | null = null;
  let keySent = false;

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const move = pendingMove;
    const wheel = pendingWheel;
    pendingMove = pendingWheel = null;
    if (move) send(move);
    if (wheel) send(wheel);
  };
  const scheduleFlush = () => {
    frame ??= requestAnimationFrame(flush);
  };
  const queueWheel = (x: number, y: number, deltaX: number, deltaY: number, modifiers: number) => {
    pendingWheel = {
      _tag: "wheel",
      x,
      y,
      deltaX: (pendingWheel?.deltaX ?? 0) + deltaX,
      deltaY: (pendingWheel?.deltaY ?? 0) + deltaY,
      modifiers,
    };
    scheduleFlush();
  };
  const countClick = (button: MouseButton, x: number, y: number, time: number) => {
    const count =
      lastClick &&
      lastClick.button === button &&
      time - lastClick.time < MULTI_CLICK_MS &&
      Math.hypot(x - lastClick.x, y - lastClick.y) < MULTI_CLICK_SLOP_PX
        ? lastClick.count + 1
        : 1;
    lastClick = { button, time, x, y, count };
    return count;
  };
  const focusKeyboard = () => keyboard.focus({ preventScroll: true });

  const onTouch = (event: PointerEvent) => {
    const { type, pointerId, clientX, clientY } = event;
    if (type === "pointerdown") {
      if (!event.isPrimary) return;
      touch = {
        pointerId,
        startX: clientX,
        startY: clientY,
        lastX: clientX,
        lastY: clientY,
        panning: false,
      };
      return;
    }
    if (!touch || touch.pointerId !== pointerId) return;
    if (type === "pointercancel") {
      touch = null;
      return;
    }
    if (type === "pointermove") {
      if (
        !touch.panning &&
        Math.hypot(clientX - touch.startX, clientY - touch.startY) < TAP_SLOP_PX
      )
        return;
      touch.panning = true;
      const point = target.toPage(clientX, clientY, true);
      const scale = target.scale();
      if (point)
        queueWheel(
          point.x,
          point.y,
          (touch.lastX - clientX) / scale,
          (touch.lastY - clientY) / scale,
          0,
        );
      touch.lastX = clientX;
      touch.lastY = clientY;
      return;
    }
    const tapped = !touch.panning;
    touch = null;
    const point = tapped ? target.toPage(clientX, clientY, false) : null;
    if (!point) return;
    if (target.isEditableAt(point.x, point.y)) focusKeyboard();
    else keyboard.blur();
    flush();
    const clickCount = countClick("left", clientX, clientY, event.timeStamp);
    const at = { x: point.x, y: point.y, modifiers: 0 };
    send({ _tag: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
    send({ _tag: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
    send({ _tag: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
  };

  const onPointer = (event: PointerEvent) => {
    if (!target.enabled()) return;
    if (event.pointerType === "touch") return onTouch(event);
    const { type, clientX, clientY } = event;
    const cancelled = type === "pointercancel";
    const previous = heldButtons;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup") heldButtons = cancelled ? 0 : event.buttons & 7;
    const point = target.toPage(
      clientX,
      clientY,
      type !== "pointerdown" &&
        (cancelled || type === "pointerup" || previous !== 0 || event.buttons !== 0),
    );
    if (!point) return;
    const at = { x: point.x, y: point.y, modifiers: inputModifiers(event) };
    const mouse = (action: "down" | "up", button: MouseButton, buttons: number) => {
      if (action === "down") clicks[button] = countClick(button, clientX, clientY, event.timeStamp);
      send({ _tag: "mouse", action, ...at, button, buttons, clickCount: clicks[button] });
    };
    if (type === "pointerdown") {
      focusKeyboard();
      surface.setPointerCapture(event.pointerId);
      flush();
      heldButtons = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons);
      return;
    }
    if (type === "pointerup") {
      flush();
      mouse("up", buttonOf(event.button), event.buttons);
      return;
    }
    // Chords arrive as pointermove; cancelling lets go of every held button.
    const next = cancelled ? 0 : event.buttons & 7;
    const changed = previous ^ next;
    if (previous !== 0 && changed !== 0) {
      flush();
      let buttons = previous;
      for (const bit of [1, 2, 4]) {
        if (!(changed & bit)) continue;
        buttons ^= bit;
        mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
      }
      heldButtons = next;
    }
    if (cancelled) return;
    pendingMove = {
      _tag: "mouse",
      action: "move",
      ...at,
      button: pressedButtonOf(event.buttons),
      buttons: event.buttons,
      clickCount: 0,
    };
    scheduleFlush();
  };

  const onWheel = (event: WheelEvent) => {
    if (!target.enabled()) return;
    const point = target.toPage(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const height = target.pageHeight();
    queueWheel(
      point.x,
      point.y,
      wheelDeltaPx(event.deltaX, event.deltaMode, height),
      wheelDeltaPx(event.deltaY, event.deltaMode, height),
      inputModifiers(event),
    );
  };

  const resetKeyboard = () => {
    keySent = false;
    keyboard.value = SENTINEL;
    keyboard.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const pressKey = (key: typeof BACKSPACE | typeof DELETE) => {
    send({ _tag: "key", action: "down", ...key, modifiers: 0 });
    send({ _tag: "key", action: "up", ...key, modifiers: 0 });
  };
  const onKey = (event: KeyboardEvent) => {
    if (!target.enabled()) return;
    keySent = false;
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    )
      return;
    if (event.key === "Escape" && event.shiftKey) {
      // The way out of the page for keyboard users.
      event.preventDefault();
      if (event.type === "keydown") keyboard.blur();
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    // Pastes arrive as a paste event with the text.
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    const action = event.type === "keydown" ? "down" : "up";
    const text = keyText(event);
    send({
      _tag: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: inputModifiers(event),
    });
    // Some Android keyboards edit the field even when keydown is prevented.
    keySent =
      action === "down" &&
      !shortcut &&
      (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    if (!shortcut) event.preventDefault();
  };
  const onInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const inputType = event instanceof InputEvent ? event.inputType : "";
    if (keySent) keySent = false;
    else if (target.enabled()) {
      if (inputType === "deleteContentBackward") pressKey(BACKSPACE);
      else if (inputType === "deleteContentForward") pressKey(DELETE);
      else {
        const text = keyboard.value.replace(/^​/, "");
        if (text) send({ _tag: "text", text });
      }
    }
    resetKeyboard();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    const text = event.data.replace(/^​/, "");
    if (text && target.enabled()) send({ _tag: "text", text });
    resetKeyboard();
  };
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text && target.enabled()) send({ _tag: "text", text });
  };
  // Copying the field would put its sentinel on the clipboard.
  const preventDefault = (event: Event) => event.preventDefault();

  const pointerEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;
  for (const type of pointerEvents) surface.addEventListener(type, onPointer);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("contextmenu", preventDefault);
  surface.addEventListener("mousedown", preventDefault);
  keyboard.addEventListener("keydown", onKey);
  keyboard.addEventListener("keyup", onKey);
  keyboard.addEventListener("input", onInput);
  keyboard.addEventListener("compositionend", onCompositionEnd);
  keyboard.addEventListener("paste", onPaste);
  keyboard.addEventListener("copy", preventDefault);
  keyboard.addEventListener("cut", preventDefault);
  keyboard.addEventListener("focus", resetKeyboard);
  resetKeyboard();

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    for (const type of pointerEvents) surface.removeEventListener(type, onPointer);
    surface.removeEventListener("wheel", onWheel);
    surface.removeEventListener("contextmenu", preventDefault);
    surface.removeEventListener("mousedown", preventDefault);
    keyboard.removeEventListener("keydown", onKey);
    keyboard.removeEventListener("keyup", onKey);
    keyboard.removeEventListener("input", onInput);
    keyboard.removeEventListener("compositionend", onCompositionEnd);
    keyboard.removeEventListener("paste", onPaste);
    keyboard.removeEventListener("copy", preventDefault);
    keyboard.removeEventListener("cut", preventDefault);
    keyboard.removeEventListener("focus", resetKeyboard);
  };
}
