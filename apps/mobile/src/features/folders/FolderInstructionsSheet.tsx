// signalbox: edits one level's AGENTS.md, what agents in it and below follow.
import { FOLDER_INSTRUCTIONS_MAX_LENGTH } from "@t3tools/contracts/signalboxFolders";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import type { InstructionsEditing } from "./use-folder-actions";

export function FolderInstructionsSheet(props: {
  readonly editing: InstructionsEditing;
  readonly onSave: (instructions: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState(props.editing.instructions);
  const [saving, setSaving] = useState(false);
  const top = props.editing.level._tag === "top";
  const save = async () => {
    setSaving(true);
    const saved = await props.onSave(text);
    setSaving(false);
    if (saved) props.onClose();
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-sheet"
        style={{
          paddingTop: Platform.OS === "ios" ? 0 : insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View className="flex-row items-center gap-2 px-2 py-2">
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center px-3 active:opacity-65"
            onPress={props.onClose}
          >
            <AppText className="text-base text-foreground">Cancel</AppText>
          </Pressable>
          <AppText
            accessibilityRole="header"
            className="min-w-0 flex-1 text-center text-base font-t3-semibold"
            numberOfLines={1}
          >
            Instructions
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: saving }}
            disabled={saving}
            className="min-h-11 justify-center px-3 active:opacity-65"
            onPress={() => void save()}
          >
            <AppText
              className={
                saving
                  ? "text-base text-foreground-tertiary"
                  : "text-base font-t3-medium text-primary"
              }
            >
              {saving ? "Saving…" : "Save"}
            </AppText>
          </Pressable>
        </View>
        <AppText className="px-5 pb-3 text-sm text-foreground-muted">
          {top
            ? `What every agent in ${props.editing.name} follows, before any folder’s own instructions.`
            : `What agents in ${props.editing.name} and the folders inside it follow, after the levels above. Moved threads pick them up from their next turn.`}
        </AppText>
        <View className="flex-1 px-4 pb-3">
          <AppTextInput
            accessibilityLabel={`Instructions for ${props.editing.name}`}
            autoFocus
            className="flex-1 text-base leading-6"
            editable={!saving}
            maxLength={FOLDER_INSTRUCTIONS_MAX_LENGTH}
            multiline
            onChangeText={setText}
            placeholder="Write in Markdown, like an AGENTS.md. Leave it empty to remove it."
            scrollEnabled
            textAlignVertical="top"
            value={text}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
