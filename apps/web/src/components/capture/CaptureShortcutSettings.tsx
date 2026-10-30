import { useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettings,
  type DesktopCaptureState,
  type KeybindingShortcut,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel } from "../settings/KeybindingsSettings.logic";
import { searchableSetting } from "../settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSnapShotShortcutRecorder } from "../settings/useSnapShotShortcutRecorder";
import { getDesktopCaptureBridge } from "./desktopCaptureBridge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export function CaptureShortcutSettings() {
  const settings = useClientSettings();
  return (
    <CaptureShortcutEditor
      key={JSON.stringify(settings.captureGlobalShortcut)}
      settings={settings}
    />
  );
}

function CaptureShortcutEditor({ settings }: { readonly settings: ClientSettings }) {
  const [bridge] = useState(getDesktopCaptureBridge);
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [candidate, setCandidate] = useState(settings.captureGlobalShortcut);
  const [state, setState] = useState<DesktopCaptureState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const changed = !sameSnapShotShortcut(candidate, settings.captureGlobalShortcut);
  const supported = navigator.platform.startsWith("Mac") && Boolean(bridge?.checkCaptureShortcut);

  useEffect(() => {
    if (!supported || !bridge) return;
    const refresh = () => {
      void bridge
        .getCaptureState()
        .then(setState)
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    const unsubscribe = bridge.onCaptureEvent(refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, supported]);

  const check = async (shortcut: KeybindingShortcut) => {
    const id = ++request.current;
    setCandidate(shortcut);
    setAvailable(false);
    const conflict = snapShotKeybindingConflict(
      shortcut,
      keybindings.filter((binding) => binding.command !== "capture.open"),
    );
    if (conflict) {
      setStatus(`Signalbox already uses this for "${commandLabel(conflict)}".`);
      return;
    }
    if (!bridge) return;
    setStatus("Checking shortcut…");
    try {
      const result = await bridge.checkCaptureShortcut(shortcut);
      if (id !== request.current) return;
      setAvailable(result.available);
      setStatus(
        result.available ? "Ready to save." : (result.message ?? "This shortcut is unavailable."),
      );
    } catch (error) {
      if (id === request.current)
        setStatus(error instanceof Error ? error.message : "Couldn't check this shortcut.");
    }
  };
  const recorder = useSnapShotShortcutRecorder({
    shortcut: candidate,
    label: "quick capture",
    disabled: !supported || busy,
    allowModifierPairs: false,
    onRecord: (shortcut) => {
      if (!isModifierPairShortcut(shortcut)) void check(shortcut);
    },
    onStart: () => {
      request.current++;
      setAvailable(false);
      setStatus(null);
    },
    onError: setStatus,
  });
  const save = async (enabled: boolean, shortcut = settings.captureGlobalShortcut) => {
    setBusy(true);
    try {
      await updateSettings({
        captureGlobalShortcutEnabled: enabled,
        captureGlobalShortcut: shortcut,
      });
      setState(await bridge!.getCaptureState());
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't save the shortcut.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="quick-capture" title="Quick capture">
      <SettingsRow
        {...searchableSetting("quick-capture-shortcut")}
        description="Write a draft from any app. Enter saves it without switching to Signalbox."
        status={
          !supported
            ? "Available in Signalbox for Mac."
            : recorder.recording
              ? "Press your shortcut. Esc cancels."
              : (status ?? state?.shortcut.message)
        }
        control={
          <>
            {recorder.input}
            {changed ? (
              <>
                <Button
                  size="xs"
                  disabled={!available || busy}
                  onClick={() => void save(settings.captureGlobalShortcutEnabled, candidate)}
                >
                  Save
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    recorder.stopRecording();
                    request.current++;
                    setCandidate(settings.captureGlobalShortcut);
                    setStatus(null);
                    setAvailable(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : null}
            <Switch
              aria-label="Enable global quick capture"
              checked={settings.captureGlobalShortcutEnabled}
              disabled={!supported || busy}
              onCheckedChange={(enabled) => void save(enabled)}
            />
          </>
        }
      />
    </SettingsSection>
  );
}
