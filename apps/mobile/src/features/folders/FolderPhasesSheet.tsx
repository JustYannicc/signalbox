// signalbox: edits a folder's phases (#677), one per line; its ⋯ menu moves between them.
import {
  FOLDER_PHASE_TEMPLATE_CHOICES,
  folderPhaseEdit,
  folderPhasesEditorText,
  folderPhaseTemplateText,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { FolderSetPhaseInput } from "@t3tools/contracts/signalboxFolders";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import type { PhasesEditing } from "./use-folder-actions";

export function FolderPhasesSheet(props: {
  readonly editing: PhasesEditing;
  readonly onSave: (change: Omit<FolderSetPhaseInput, "id">) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { folder } = props.editing;
  const [text, setText] = useState(() =>
    folderPhasesEditorText(folder.phase, props.editing.ownerKind),
  );
  const [saving, setSaving] = useState(false);
  const edit = folderPhaseEdit(folder.phase, text);
  const save = async (change: Omit<FolderSetPhaseInput, "id">) => {
    if (change.phases !== null && edit.unchanged) return props.onClose();
    setSaving(true);
    const saved = await props.onSave(change);
    setSaving(false);
    if (saved) props.onClose();
  };
  const canSave = !saving && edit.problem === null;
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
            Phases
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            className="min-h-11 justify-center px-3 active:opacity-65"
            onPress={() =>
              void save({
                phases: edit.phases,
                ...(edit.current === undefined ? {} : { current: edit.current }),
              })
            }
          >
            <AppText
              className={
                canSave
                  ? "text-base font-t3-medium text-primary"
                  : "text-base text-foreground-tertiary"
              }
            >
              {saving ? "Saving…" : "Save"}
            </AppText>
          </Pressable>
        </View>
        <AppText className="px-5 pb-3 text-sm text-foreground-muted">
          {`Where ${folder.name} is in its life, separate from its threads. One phase per line, in order. Move between them from the folder’s ⋯ menu.`}
        </AppText>
        <View className="flex-row flex-wrap items-center gap-2 px-5 pb-3">
          <AppText className="text-sm text-foreground-muted">Start from</AppText>
          {FOLDER_PHASE_TEMPLATE_CHOICES.map((template) => (
            <Chip
              key={template.kind}
              label={template.label}
              size="small"
              disabled={saving}
              onPress={() => setText(folderPhaseTemplateText(template.kind))}
            />
          ))}
        </View>
        {/* Above the input: the keyboard covers whatever sits below it. */}
        <View className="flex-row items-center gap-3 px-5 pb-3">
          <AppText
            accessibilityLiveRegion="polite"
            className={
              edit.problem === null
                ? "min-w-0 flex-1 text-sm text-foreground-muted"
                : "min-w-0 flex-1 text-sm text-danger-foreground"
            }
          >
            {edit.status}
          </AppText>
          {folder.phase === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              className="min-h-11 justify-center active:opacity-65"
              onPress={() => void save({ phases: null })}
            >
              <AppText className="text-base text-danger-foreground">Remove phases</AppText>
            </Pressable>
          )}
        </View>
        <View className="flex-1 px-4 pb-3">
          <AppTextInput
            accessibilityLabel={`Phases for ${folder.name}, one per line`}
            autoFocus
            className="flex-1 text-base leading-6"
            editable={!saving}
            multiline
            onChangeText={setText}
            placeholder={"Proposal\nImplementation\nProduction"}
            scrollEnabled
            textAlignVertical="top"
            value={text}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
