export interface CaptureShortcutRegistry {
  register(accelerator: string, listener: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface CaptureShortcutResult {
  readonly registered: boolean;
  readonly message: string | null;
}

export function makeCaptureShortcutRegistration(registry: CaptureShortcutRegistry) {
  let registeredAccelerator: string | undefined;

  const stop = () => {
    if (registeredAccelerator === undefined) return;
    registry.unregister(registeredAccelerator);
    registeredAccelerator = undefined;
  };

  return {
    get registeredAccelerator() {
      return registeredAccelerator;
    },
    stop,
    configure(input: {
      readonly enabled: boolean;
      readonly suppressed: boolean;
      readonly accelerator: string;
      readonly onTrigger: () => void;
    }): CaptureShortcutResult {
      stop();
      if (!input.enabled || input.suppressed) return { registered: false, message: null };
      try {
        if (!registry.register(input.accelerator, input.onTrigger)) {
          return {
            registered: false,
            message: "This shortcut is already used by the system or another app.",
          };
        }
        registeredAccelerator = input.accelerator;
        return { registered: true, message: null };
      } catch {
        return { registered: false, message: "The system could not register this shortcut." };
      }
    },
  };
}

export function dispatchCaptureShortcut(input: {
  readonly mainWindowFocused: boolean;
  readonly dispatchMainAction: () => void;
  readonly showPanel: () => void;
}): void {
  if (input.mainWindowFocused) input.dispatchMainAction();
  else input.showPanel();
}
