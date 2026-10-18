import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SettingsRow } from "./components/SettingsRow";

interface CaptureTileNative {
  readonly isAdded: () => boolean;
  readonly requestAddTile: () => Promise<"added" | "cancelled" | "unsupported">;
}

export function CaptureTileSettingsRow() {
  const [native] = useState(() =>
    Platform.OS === "android"
      ? requireOptionalNativeModule<CaptureTileNative>("SignalboxCaptureTile")
      : null,
  );
  const [added, setAdded] = useState(() => native?.isAdded() ?? false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!native) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setAdded(native.isAdded());
    });
    return () => subscription.remove();
  }, [native]);

  if (!native) return null;

  const addTile = async () => {
    if (requesting) return;
    if (added) {
      Dialog.alert(
        "Capture is in Quick Settings",
        "To remove it, pull down Quick Settings, tap Edit, then remove Capture.",
      );
      return;
    }
    setRequesting(true);
    try {
      const result = await native.requestAddTile();
      if (result === "added") setAdded(true);
      else if (result === "unsupported") {
        Dialog.alert(
          "Add Capture to Quick Settings",
          "Pull down Quick Settings, tap Edit, then add Capture.",
        );
      }
    } catch {
      Dialog.alert(
        "Couldn't add Capture",
        "Try again while Signalbox is open, or add Capture from Quick Settings → Edit.",
      );
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SettingsRow
      icon="plus"
      label="Capture in Quick Settings"
      value={added ? "Added" : requesting ? "Adding…" : "Add Capture"}
      disabled={requesting}
      onPress={() => void addTile()}
    />
  );
}
