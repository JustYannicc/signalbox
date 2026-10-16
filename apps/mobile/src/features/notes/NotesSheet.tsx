// signalbox: one level's scratch pad: jot half-formed thoughts, and OK what their reader offers.
import {
  acceptedMessage,
  canShareWithTeam,
  noteOffer,
  notesShown,
  padNotes,
} from "@t3tools/client-runtime/state/signalboxNotes";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import {
  NOTE_TEXT_MAX_LENGTH,
  type Note,
  type NoteVisibility,
} from "@t3tools/contracts/signalboxNotes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
  type ListRenderItem,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Toast } from "../../components/ui/Toast";
import { useEnvironmentFolders } from "../../state/signalboxFolders";
import { useEnvironmentNotes } from "../../state/signalboxNotes";
import { NoteRow } from "./NoteRow";
import { useNoteActions } from "./use-note-actions";

/** The level whose scratch pad is open. Its folder is read live, so renames and moves show. */
export interface NotesOpen {
  readonly environmentId: EnvironmentId;
  readonly level: FolderLevel;
}

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Only you" },
  { value: "team", label: "Team" },
] as const satisfies ReadonlyArray<{ value: NoteVisibility; label: string }>;

interface Accepted {
  readonly title: string;
  readonly description: string;
  readonly threadId: ThreadId;
}

const TOAST_MS = 8000;
const LOCK: AppSymbolName = { ios: "lock", android: "lock" };

function HeaderButton(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-11 min-w-16 justify-center px-3 active:opacity-65"
      onPress={props.onPress}
    >
      <AppText className="text-base font-t3-medium text-primary">{props.label}</AppText>
    </Pressable>
  );
}

export function NotesSheet(props: {
  readonly open: NotesOpen;
  readonly onClose: () => void;
  /** After the sheet is gone: opens the task a note became. */
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { open } = props;
  const { environmentId, level } = open;
  const insets = useSafeAreaInsets();
  const folders = useEnvironmentFolders(environmentId).data;
  const folder =
    level._tag === "folder"
      ? (folders?.folders.find((candidate) => candidate.id === level.folderId) ?? null)
      : null;
  // Deleted while open: its notes moved up a level, so this pad is gone.
  const gone = level._tag === "folder" && folders != null && folder === null;
  const folderName = folder?.name ?? null;
  const shareable = canShareWithTeam(folder);
  const [visibility, setVisibility] = useState<NoteVisibility>("private");
  const [draft, setDraft] = useState("");
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const notes = useEnvironmentNotes(environmentId);
  const actions = useNoteActions({ environmentId, level });

  const shown = useMemo(
    () => notesShown(notes.data ? padNotes(notes.data, level) : [], shareable, visibility),
    [notes.data, level, shareable, visibility],
  );

  // Closing slides the sheet away first; what runs after waits for UIKit to finish.
  const [closing, setClosing] = useState(false);
  const visible = !closing && !gone;
  const afterClose = useRef<(() => void) | null>(null);
  const closed = useRef(false);
  const { onClose } = props;
  const finishClose = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
    afterClose.current?.();
  }, [onClose]);
  useEffect(() => {
    if (visible) return;
    // onDismiss is iOS-only and can be dropped when another sheet races it.
    const fallback = setTimeout(finishClose, Platform.OS === "ios" ? 400 : 0);
    return () => clearTimeout(fallback);
  }, [finishClose, visible]);
  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    setClosing(true);
  };

  useEffect(() => {
    if (accepted === null) return;
    const timer = setTimeout(() => setAccepted(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [accepted]);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    // Cleared at once so the next thought can follow; put back if it wasn't kept.
    setDraft("");
    void actions.add(text, visibility).then((added) => {
      if (!added) setDraft((current) => (current === "" ? text : current));
    });
  };

  const { accept: acceptNote, dismiss, onNoteAction } = actions;
  const onAccept = useCallback(
    async (note: Note) => {
      const offer = noteOffer(note);
      if (offer === null) return;
      const threadId = await acceptNote(note);
      if (threadId === null) return;
      setAccepted({ ...acceptedMessage(offer, folderName), threadId });
    },
    [acceptNote, folderName],
  );

  const renderItem = useCallback<ListRenderItem<Note>>(
    ({ item }) => (
      <NoteRow
        note={item}
        folderName={folderName}
        canShare={shareable}
        onAction={onNoteAction}
        onAccept={onAccept}
        onDismiss={dismiss}
      />
    ),
    [dismiss, folderName, onAccept, onNoteAction, shareable],
  );

  const team = shareable && visibility === "team";
  const done = <HeaderButton label="Done" onPress={() => close()} />;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={() => close()}
      onDismiss={finishClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-sheet"
        style={{
          paddingTop: Platform.OS === "ios" ? 0 : insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View className="flex-row items-center px-2 py-2">
          {Platform.OS === "ios" ? <View className="min-w-16" /> : done}
          <View className="min-w-0 flex-1 items-center">
            <AppText
              accessibilityRole="header"
              className="text-base font-t3-semibold"
              numberOfLines={1}
            >
              Scratch pad
            </AppText>
            <AppText textRole="label" className="text-foreground-muted" numberOfLines={1}>
              {folderName ?? "Top level"}
            </AppText>
          </View>
          {Platform.OS === "ios" ? done : <View className="min-w-16" />}
        </View>

        <View className="gap-3 px-4 pt-2 pb-1">
          {shareable ? (
            <SegmentedControl
              options={VISIBILITY_OPTIONS}
              selected={visibility}
              onSelect={setVisibility}
              size="compact"
            />
          ) : (
            <View className="flex-row items-center gap-1.5">
              <SymbolView name={LOCK} size={13} tintColorClassName="accent-icon-muted" />
              <AppText textRole="label" className="text-foreground-muted">
                Only you
              </AppText>
            </View>
          )}
          <AppTextInput
            accessibilityLabel="New note"
            autoFocus
            className="max-h-40 text-base leading-6"
            maxLength={NOTE_TEXT_MAX_LENGTH}
            multiline
            onChangeText={setDraft}
            onSubmitEditing={add}
            placeholder={
              team ? "Jot something the team can see" : "Jot something, half-formed is fine"
            }
            submitBehavior="submit"
            textAlignVertical="top"
            value={draft}
          />
        </View>

        <FlatList
          className="flex-1"
          contentContainerClassName="px-4 pb-6"
          data={shown}
          keyExtractor={(note) => note.id}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            notes.data ? (
              <AppText textRole="footnote" className="py-3 text-foreground-muted">
                Nothing here. Return adds a note.
              </AppText>
            ) : notes.error ? (
              <View className="flex-row items-center gap-3 py-3">
                <AppText textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
                  Couldn’t load notes. {notes.error}
                </AppText>
                <HeaderButton label="Retry" onPress={notes.refresh} />
              </View>
            ) : (
              <AppText textRole="footnote" className="py-3 text-foreground-muted">
                Loading notes…
              </AppText>
            )
          }
        />

        {accepted ? (
          <View className="absolute inset-x-4" style={{ bottom: insets.bottom + 12 }}>
            <Toast
              message={accepted.title}
              description={accepted.description}
              tone="success"
              action={{
                label: "Open",
                onPress: () => {
                  const { threadId } = accepted;
                  close(() => props.onOpenThread(threadId));
                },
              }}
              onDismiss={() => setAccepted(null)}
            />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Separator() {
  return <View className="h-px bg-border" />;
}
