import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
  type VoiceRecordingSink,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  readonly onRecording?: VoiceRecordingSink;
}) {
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session, stop: stopVoiceInput } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback((): Promise<void> => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return Promise.resolve();
    return session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      ...(captured.onRecording ? { onRecording: captured.onRecording } : {}),
    });
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  const pendingRecordingOwnerKey = session.pendingRecordingOwnerKey;
  const hasPendingRecording = useCallback(
    () => input.ownerKey !== null && session.pendingRecordingOwnerKey === input.ownerKey,
    [input.ownerKey, session],
  );
  const stop = useCallback(() => {
    if (input.ownerKey === null || session.ownerKey !== input.ownerKey) return Promise.resolve();
    return stopVoiceInput();
  }, [input.ownerKey, session, stopVoiceInput]);
  const cancelOwned = useCallback(() => {
    const ownerKey = input.ownerKey;
    if (ownerKey !== null && session.ownerKey === ownerKey) session.cancel(ownerKey);
  }, [input.ownerKey, session]);
  const cancelPendingRecording = useCallback(() => {
    const ownerKey = input.ownerKey;
    if (ownerKey !== null && session.pendingRecordingOwnerKey === ownerKey) {
      session.cancel(ownerKey);
    }
  }, [input.ownerKey, session]);
  return {
    isAvailable:
      input.ownerKey !== null &&
      (global.isAvailable ||
        input.onRecording !== undefined ||
        pendingRecordingOwnerKey === input.ownerKey) &&
      (pendingRecordingOwnerKey === null || pendingRecordingOwnerKey === input.ownerKey) &&
      (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop,
    cancel: cancelOwned,
    cancelOwned,
    hasPendingRecording,
    cancelPendingRecording,
  };
}
