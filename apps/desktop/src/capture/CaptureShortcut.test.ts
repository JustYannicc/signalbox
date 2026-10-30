import { assert, describe, it } from "@effect/vitest";

import { dispatchCaptureShortcut, makeCaptureShortcutRegistration } from "./CaptureShortcut.ts";

describe("capture shortcut", () => {
  it("replaces and releases the registered shortcut across settings changes", () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    const registry = makeCaptureShortcutRegistration({
      register: (accelerator) => {
        registered.push(accelerator);
        return accelerator !== "CommandOrControl+Shift+X";
      },
      unregister: (accelerator) => unregistered.push(accelerator),
    });

    assert.deepEqual(
      registry.configure({
        enabled: true,
        suppressed: false,
        accelerator: "CommandOrControl+Shift+Space",
        onTrigger: () => undefined,
      }),
      { registered: true, message: null },
    );
    assert.equal(registry.registeredAccelerator, "CommandOrControl+Shift+Space");
    assert.deepEqual(
      registry.configure({
        enabled: true,
        suppressed: false,
        accelerator: "CommandOrControl+Shift+X",
        onTrigger: () => undefined,
      }),
      {
        registered: false,
        message: "This shortcut is already used by the system or another app.",
      },
    );
    assert.deepEqual(unregistered, ["CommandOrControl+Shift+Space"]);
    assert.isUndefined(registry.registeredAccelerator);
    registry.stop();
    assert.deepEqual(unregistered, ["CommandOrControl+Shift+Space"]);
  });

  it("dispatches to the main action only when the main window has focus", () => {
    const calls: string[] = [];
    dispatchCaptureShortcut({
      mainWindowFocused: true,
      dispatchMainAction: () => calls.push("main"),
      showPanel: () => calls.push("panel"),
    });
    dispatchCaptureShortcut({
      mainWindowFocused: false,
      dispatchMainAction: () => calls.push("main"),
      showPanel: () => calls.push("panel"),
    });
    assert.deepEqual(calls, ["main", "panel"]);
  });
});
