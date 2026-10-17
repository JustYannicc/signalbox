// signalbox: one note on a pad: the author's words, and under them what its reader made of them.
import {
  conditionLabel,
  noteOffer,
  readerNames,
} from "@t3tools/client-runtime/state/signalboxNotes";
import type { Note } from "@t3tools/contracts/signalboxNotes";
import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { noteMenuActions } from "./note-menus";

// The iOS menu drops `className`, so the text column's flex goes in `style`.
const TEXT_COLUMN = { flex: 1, minWidth: 0 } as const;

export const NoteRow = memo(function NoteRow(props: {
  readonly note: Note;
  /** The note's folder, null at the top level: who reads it is named after it. */
  readonly folderName: string | null;
  readonly canShare: boolean;
  readonly onAction: (note: Note, event: string) => void;
  readonly onAccept: (note: Note) => Promise<void>;
  readonly onDismiss: (note: Note) => void;
}) {
  const { note } = props;
  const offer = noteOffer(note);
  const reading = note.reading;
  const reader = reading ? readerNames(reading.reader, props.folderName) : null;
  const actions = useMemo(
    () => noteMenuActions(note, { canShare: props.canShare }),
    [note, props.canShare],
  );
  const [accepting, setAccepting] = useState(false);
  const accept = async () => {
    setAccepting(true);
    await props.onAccept(note);
    setAccepting(false);
  };
  const onPressAction = ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) =>
    props.onAction(note, nativeEvent.event);

  return (
    <View className="gap-2 py-3">
      <View className="flex-row items-start gap-1">
        <Menu
          actions={actions}
          style={TEXT_COLUMN}
          onPressAction={onPressAction}
          shouldOpenOnLongPress
        >
          <Pressable accessibilityHint="Long-press for note actions" className="pt-2">
            <AppText className="text-base leading-6 text-foreground">{note.text}</AppText>
          </Pressable>
        </Menu>
        <Menu actions={actions} onPressAction={onPressAction} title="Note">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Note actions"
            className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
          >
            <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      </View>
      {offer && reader ? (
        <View className="gap-2 rounded-2xl bg-subtle px-3.5 py-3">
          <AppText textRole="label" className="text-foreground-muted">
            {reader.subject} reads this as
          </AppText>
          <AppText textRole="footnote" className="text-foreground">
            {offer.meaning}
          </AppText>
          {offer.condition ? (
            <View className="flex-row items-center gap-1.5 self-start rounded-full border border-border px-2.5 py-0.5">
              <SymbolView name="clock" size={13} tintColorClassName="accent-icon-muted" />
              <AppText textRole="label" className="text-foreground-muted">
                {conditionLabel(offer.condition)}
              </AppText>
            </View>
          ) : null}
          <AppText textRole="footnote" className="text-foreground-muted">
            {offer.action}
          </AppText>
          <View className="flex-row flex-wrap items-center gap-1 pt-1">
            <Button
              label="OK, do it"
              icon="checkmark"
              loading={accepting}
              onPress={() => void accept()}
            />
            <Button
              label="Not this"
              tone="text"
              disabled={accepting}
              onPress={() => props.onDismiss(note)}
            />
          </View>
        </View>
      ) : reading?._tag === "unclear" && reader ? (
        <AppText textRole="label" className="text-foreground-muted">
          {reader.subject} isn’t sure what this means yet. It’ll stay a note.
        </AppText>
      ) : null}
    </View>
  );
});
