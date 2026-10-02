/**
 * `@` people mentions for `MockBoundComposer`, on the chat composer's own
 * machinery: `detectComposerTrigger` finds the `@query`, the real command menu
 * drawer lists the matches, and picking one inserts an `@handle ` token the
 * editor chips. The surface supplies the matches and how a handle renders.
 * The real chat composer merges the same people/agent items into its file menu.
 * An optional `tags` source does the same for `#tag` (projects, sections,
 * chats), riding the `#` trigger the real composer uses for pull requests.
 */
import { useState, type ReactNode } from "react";

import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  replaceTextRange,
  type ComposerTrigger,
} from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { formatComposerMention } from "../composerMentionRenderer";
import { ComposerCommandMenuLayer } from "./ChatComposer";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

export type ComposerMentionItem = Extract<ComposerCommandItem, { type: "person" }>;

export interface ComposerMentionSource {
  /** Matches for the text after `@`. */
  readonly items: (query: string) => ReadonlyArray<ComposerMentionItem>;
  /** How a chipped `@handle` renders in the editor; `null` keeps the file chip. */
  readonly renderMention: (handle: string) => ReactNode | null;
  readonly emptyStateText?: string;
  /** Called with the text after `@` as it changes, for sources that fetch per query. */
  readonly onQueryChange?: (query: string) => void;
}

/** `#` tags; a pick inserts `#handle `, so handles have no spaces. */
export interface ComposerTagSource {
  /** Matches for the text after `#`. */
  readonly items: (query: string) => ReadonlyArray<ComposerMentionItem>;
  readonly emptyStateText?: string;
  /** Called with the text after `#` as it changes. */
  readonly onQueryChange?: (query: string) => void;
}

export function useComposerMentionMenu(input: {
  source: ComposerMentionSource | undefined;
  tags?: ComposerTagSource | undefined;
  prompt: string;
  /** Sets the prompt after a pick and puts the caret at `cursor`. */
  applyPrompt: (prompt: string, cursor: number) => void;
}) {
  const { source, tags } = input;
  const { resolvedTheme } = useTheme();
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const menuSource =
    trigger?.kind === "path" ? source : trigger?.kind === "pull-request" ? tags : undefined;
  const open = menuSource !== undefined && trigger !== null;
  const items = menuSource && trigger ? menuSource.items(trigger.query) : [];
  const active = items.find((item) => item.id === activeId) ?? items[0] ?? null;

  const select = (item: ComposerMentionItem) => {
    if (!trigger) return;
    const next = replaceTextRange(
      input.prompt,
      trigger.rangeStart,
      trigger.rangeEnd,
      `${trigger.kind === "pull-request" ? `#${item.handle}` : formatComposerMention(item.handle)} `,
    );
    const cursor = collapseExpandedComposerCursor(next.text, next.cursor);
    input.applyPrompt(next.text, cursor);
    setTrigger(null);
    setActiveId(null);
  };

  const move = (step: 1 | -1) => {
    if (items.length === 0) return;
    const index = active ? items.indexOf(active) : -1;
    setActiveId(items[(index + step + items.length) % items.length]?.id ?? null);
  };

  return {
    anchorRef: setAnchor,
    renderMention: source?.renderMention ?? null,
    /** Call from the editor's `onChange`. */
    onEditorChange: (value: string, expandedCursor: number, adjacentToChip: boolean) => {
      const next =
        (source || tags) && !adjacentToChip ? detectComposerTrigger(value, expandedCursor) : null;
      setTrigger(next);
      setActiveId(null);
      if (next?.kind === "path") source?.onQueryChange?.(next.query);
      else if (next?.kind === "pull-request") tags?.onQueryChange?.(next.query);
    },
    /** Call first from `onCommandKeyDown`; `true` means the menu took the key. */
    onCommandKey: (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape") => {
      if (!open) return false;
      if (key === "Escape") {
        setTrigger(null);
        return true;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        move(key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (!active) return false;
      select(active);
      return true;
    },
    menu: menuSource ? (
      <ComposerCommandMenuLayer anchor={anchor}>
        <ComposerCommandMenu
          items={[...items]}
          resolvedTheme={resolvedTheme}
          isLoading={false}
          triggerKind="path"
          emptyStateText={
            menuSource.emptyStateText ??
            (trigger?.kind === "pull-request" ? "Nothing matches." : "Nobody matches.")
          }
          activeItemId={active?.id ?? null}
          onHighlightedItemChange={setActiveId}
          onSelect={(item) => {
            if (item.type === "person") select(item);
          }}
        />
      </ComposerCommandMenuLayer>
    ) : null,
  };
}
