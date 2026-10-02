import type { ReactNode } from "react";

import { ComposerMentionRendererContext } from "./composerMentionRenderer";
import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode renders every
 * marker as a literal character and serializes byte-identically.
 * `renderMention` lets `@handle` chips render as people or agents instead of files.
 */
export function ComposerPromptEditor({
  renderMention,
  ...props
}: ComposerPromptEditorProps & {
  renderMention?: ((handle: string) => ReactNode | null) | null | undefined;
}) {
  const editor = <ComposerPromptEditorTiptap {...props} />;
  if (!renderMention) return editor;
  return (
    <ComposerMentionRendererContext value={renderMention}>{editor}</ComposerMentionRendererContext>
  );
}
