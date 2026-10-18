import { Linking, Pressable, View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { useCaptureVoiceNote } from "./useCaptureVoiceNote";

export function CaptureVoiceButton(props: {
  readonly voice: ReturnType<typeof useCaptureVoiceNote>;
  readonly disabled: boolean;
}) {
  const { voice } = props;
  const phase = voice.state.phase;
  const recording = phase === "recording";
  const waiting = phase === "preparing" || phase === "transcribing";
  const label = recording
    ? "Stop recording"
    : voice.hasPendingAudio
      ? "Retry voice note"
      : "Record voice note";
  const disabled = props.disabled || waiting || !voice.isAvailable;
  return (
    <View className="flex-col gap-1">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled, busy: waiting }}
          disabled={disabled}
          className="size-12 shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
          onPress={() => {
            if (recording) void voice.stop();
            else void voice.start();
          }}
        >
          {waiting ? (
            <AppActivityIndicator />
          ) : recording ? (
            <View className="size-3 rounded-sm bg-danger" />
          ) : (
            <SymbolView name="mic" size={20} tintColorClassName="accent-icon" />
          )}
        </Pressable>
        {recording ? (
          <Text className="text-sm text-foreground-muted" accessibilityLiveRegion="none">
            {Math.floor(voice.elapsedSeconds / 60)}:
            {String(Math.floor(voice.elapsedSeconds % 60)).padStart(2, "0")}
          </Text>
        ) : null}
        {voice.hasPendingAudio ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard unsaved audio"
            accessibilityHint="Removes this unsaved recording. Your text and other attachments stay in the draft."
            accessibilityState={{ disabled: waiting, busy: waiting }}
            disabled={waiting}
            className="min-h-12 shrink-0 justify-center px-2 active:opacity-70 disabled:opacity-50"
            onPress={() => {
              void voice.discardPendingAudio().catch(() => undefined);
            }}
          >
            <Text className="text-sm text-foreground-muted">Discard unsaved audio</Text>
          </Pressable>
        ) : null}
        {voice.state.errorAction === "settings" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open settings"
            onPress={() => {
              void Linking.openSettings();
            }}
          >
            <Text className="text-sm text-primary">Open settings</Text>
          </Pressable>
        ) : null}
      </View>
      {voice.discardError ? (
        <Text className="text-xs text-danger-foreground" accessibilityLiveRegion="polite">
          {voice.discardError}
        </Text>
      ) : null}
    </View>
  );
}
