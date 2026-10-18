import type { ThreadFindDocument, ThreadFindDisplaySlot } from "@t3tools/shared/threadFindText";
import { useMemo } from "react";

import { uuidv4 } from "../../../lib/uuid";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import {
  threadFindGeneratedMarkdown,
  threadFindGeneratedSelection,
} from "./thread-find-generated-text";
import { useThreadFindReveal } from "./thread-find-reveal-context";
import { useThreadFindNativeReveal } from "./use-thread-find-native-reveal";

export function ThreadFindGeneratedText(props: {
  readonly entryId: string;
  readonly document: ThreadFindDocument;
  readonly slot: ThreadFindDisplaySlot;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly numberOfLines?: number;
}) {
  const reveal = useThreadFindReveal(props.entryId);
  const { kind, sourceStart, sourceEnd, text } = props.slot;
  const slot = useMemo(
    () => ({ kind, sourceStart, sourceEnd, text }),
    [kind, sourceStart, sourceEnd, text],
  );
  const revision = useMemo(() => uuidv4(), [props.document, slot, reveal.request]);
  const rendered = useMemo(() => threadFindGeneratedMarkdown(props.slot.text), [props.slot.text]);
  const selection = useMemo(
    () =>
      threadFindGeneratedSelection({
        document: props.document,
        slot,
        revision,
        request: reveal.request ? { ...reveal.request, revision } : null,
      }),
    [props.document, slot, revision, reveal.request],
  );
  const onSourceSelection = useThreadFindNativeReveal(reveal, revision, selection);
  return (
    <SelectableMarkdownText
      markdown={rendered.markdown}
      preparedMarkdown
      sourceDocumentRevision={revision}
      sourceSelection={selection}
      onSourceSelection={onSourceSelection}
      numberOfLines={selection ? undefined : props.numberOfLines}
      textStyle={{ ...props.textStyle, paragraphMarginBottom: 0 }}
    />
  );
}
