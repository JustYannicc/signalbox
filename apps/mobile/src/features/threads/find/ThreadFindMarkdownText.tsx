import type { ThreadFindDocument } from "@t3tools/shared/threadFindText";
import type { TextSourceMap } from "@t3tools/shared/textSourceMap";
import { useMemo } from "react";

import { uuidv4 } from "../../../lib/uuid";
import { SelectableMarkdownText } from "../../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../../native/SelectableMarkdownText.types";
import {
  createThreadFindMarkdownManifest,
  prepareThreadFindMarkdown,
} from "./thread-find-markdown";
import { useThreadFindReveal } from "./thread-find-reveal-context";
import { useThreadFindNativeReveal } from "./use-thread-find-native-reveal";

export function ThreadFindMarkdownText(
  props: Omit<SelectableMarkdownTextProps, "markdown"> & {
    readonly entryId: string;
    readonly document: ThreadFindDocument;
    readonly sourceMap: TextSourceMap;
  },
) {
  const { entryId, document, sourceMap, ...textProps } = props;
  const reveal = useThreadFindReveal(entryId);
  const { request } = reveal;
  const prepared = useMemo(() => prepareThreadFindMarkdown(sourceMap), [sourceMap]);
  const revision = useMemo(() => uuidv4(), [document, prepared, props.skills, request]);
  const manifest = useMemo(
    () =>
      createThreadFindMarkdownManifest({
        document,
        sourceMap: prepared,
        revision,
        skills: props.skills,
        request: request ? { ...request, revision } : undefined,
      }),
    [document, prepared, revision, request, props.skills],
  );
  const onSourceSelection = useThreadFindNativeReveal(
    reveal,
    revision,
    manifest?.sourceSelection ?? null,
  );

  return (
    <SelectableMarkdownText
      {...textProps}
      markdown={manifest?.markdown ?? prepared.text}
      preparedMarkdown
      sourceDocumentRevision={revision}
      sourceSelection={manifest?.sourceSelection ?? null}
      sourceLinkPillContent={manifest?.sourceLinkPillContent}
      onSourceSelection={onSourceSelection}
    />
  );
}
