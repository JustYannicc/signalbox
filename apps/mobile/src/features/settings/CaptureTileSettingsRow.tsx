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
    const refresh = () => setAdded(native.isAdded());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const focus = AppState.addEventListener("focus", refresh);
    return () => {
      subscription.remove();
      focus.remove();
    };
  }, [native]);

  if (!native) return null;

  const addTile = async () => {
    if (requesting) return;
    const currentlyAdded = native.isAdded();
    setAdded(currentlyAdded);
    if (currentlyAdded) {
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
      Dialog.alert("Couldn't add Capture", "Try again, or add Capture from Quick Settings → Edit.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SettingsRow
      icon="plus"
      label="Capture in Quick Settings"
      value={added ? "Added" : requesting ? "Adding…" : "Add Capture · or Quick Settings → Edit"}
      disabled={requesting}
      onPress={() => void addTile()}
    />
  );
}
