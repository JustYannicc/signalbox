/**
 * One block of a native note. Text blocks are auto-growing plain textareas, so
 * the body stays Markdown-shaped without contentEditable. Typing "/" opens the
 * block menu; "# ", "## ", "[] ", "- " and "> " convert a paragraph in place.
 */
import { ArrowUpRightIcon, LightbulbIcon } from "lucide-react";
import { memo, useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Checkbox } from "../ui/checkbox";
import type { SpacesItemFixture } from "./spacesFixtures";
import { ItemTypeIcon, SourceMark } from "./SpacesGlyphs";
import { findSource, itemConnector } from "./spacesModel";
import type { NoteBlock, NoteBlockType } from "./spacesNotes";
import { slashOptionId, slashOptions, SpacesSlashMenu, type SlashOption } from "./SpacesSlashMenu";

export interface NoteBlockActions {
  readonly change: (id: string, text: string) => void;
  readonly setType: (id: string, type: NoteBlockType, text?: string) => void;
  readonly toggle: (id: string) => void;
  /** Enter: splits at the caret into a new block below. */
  readonly split: (id: string, caret: number) => void;
  /** Backspace at the very start: demote, merge up, or delete. */
  readonly backspaceAtStart: (id: string) => void;
  readonly move: (id: string, direction: -1 | 1) => void;
  readonly link: (id: string, itemId: string) => void;
  readonly remove: (id: string) => void;
  readonly openItem: (item: SpacesItemFixture) => void;
}

const SHORTCUTS: readonly [RegExp, NoteBlockType][] = [
  [/^## /, "heading2"],
  [/^# /, "heading1"],
  [/^\[ ?\] /, "todo"],
  [/^[-*] /, "bullet"],
  [/^> /, "callout"],
];

const TEXT_CLASS: Partial<Record<NoteBlockType, string>> = {
  heading1: "text-xl font-semibold tracking-tight",
  heading2: "text-lg font-semibold",
};

const PLACEHOLDER: Record<NoteBlockType, string> = {
  paragraph: "Type / for blocks, or just write",
  heading1: "Heading",
  heading2: "Subheading",
  todo: "To-do",
  bullet: "List item",
  callout: "Callout",
  link: "",
};

function LinkChip(props: {
  block: NoteBlock;
  item: SpacesItemFixture | undefined;
  registerRef: (id: string, element: HTMLElement | null) => void;
  actions: NoteBlockActions;
}) {
  const { block, item, actions } = props;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      actions.remove(block.id);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      actions.move(block.id, event.key === "ArrowUp" ? -1 : 1);
    }
  };
  return (
    <button
      ref={(element) => props.registerRef(block.id, element)}
      type="button"
      disabled={!item}
      onClick={() => item && actions.openItem(item)}
      onKeyDown={onKeyDown}
      className="flex w-full max-w-md cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:border-ring disabled:cursor-default"
    >
      {item ? (
        <>
          <SourceMark connector={itemConnector(item)} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <ItemTypeIcon type={item.type} className="size-3.5 text-muted-foreground" />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {findSource(item.source)?.name} · {item.location}
            </span>
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      ) : (
        <span className="text-muted-foreground">Linked item is no longer in this space</span>
      )}
    </button>
  );
}

export const SpacesNoteBlock = memo(function SpacesNoteBlock(props: {
  block: NoteBlock;
  /** The page this block is on, left out of its own link suggestions. */
  noteId: string;
  items: readonly SpacesItemFixture[];
  registerRef: (id: string, element: HTMLElement | null) => void;
  actions: NoteBlockActions;
}) {
  const { block, items, actions } = props;
  const menuId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  if (block.type === "link") {
    const item = items.find((entry) => entry.id === block.itemId);
    return <LinkChip block={block} item={item} registerRef={props.registerRef} actions={actions} />;
  }

  const slashQuery =
    focused && !dismissed && /^\/[^\n]{0,40}$/.test(block.text) ? block.text.slice(1) : null;
  const options = slashQuery === null ? [] : slashOptions(slashQuery, items, props.noteId);
  const menuOpen = slashQuery !== null;

  const pick = (option: SlashOption) => {
    if (option.kind === "block") actions.setType(block.id, option.type, "");
    else actions.link(block.id, option.item.id);
  };

  const onChange = (text: string) => {
    setActiveIndex(0);
    if (!text.startsWith("/")) setDismissed(false);
    if (block.type === "paragraph") {
      const shortcut = SHORTCUTS.find(([pattern]) => pattern.test(text));
      if (shortcut) {
        actions.setType(block.id, shortcut[1], text.replace(shortcut[0], ""));
        return;
      }
    }
    actions.change(block.id, text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let an IME finish composing before Enter or arrows mean anything.
    if (event.nativeEvent.isComposing) return;
    const target = event.currentTarget;
    const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
    const atEnd = target.selectionStart === target.value.length;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + options.length) % Math.max(options.length, 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const option = options[activeIndex];
        if (option) pick(option);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      actions.split(block.id, target.selectionStart);
    } else if (event.key === "Backspace" && atStart) {
      event.preventDefault();
      actions.backspaceAtStart(block.id);
    } else if (event.key === "ArrowUp" && atStart) {
      event.preventDefault();
      actions.move(block.id, -1);
    } else if (event.key === "ArrowDown" && atEnd) {
      event.preventDefault();
      actions.move(block.id, 1);
    }
  };

  const textarea = (
    <textarea
      ref={(element) => props.registerRef(block.id, element)}
      rows={1}
      value={block.text}
      placeholder={PLACEHOLDER[block.type]}
      aria-label={PLACEHOLDER[block.type]}
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}
      aria-activedescendant={
        menuOpen && options.length > 0 ? slashOptionId(menuId, activeIndex) : undefined
      }
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn(
        "field-sizing-content block w-full min-w-0 resize-none bg-transparent leading-7 text-foreground outline-none placeholder:text-muted-foreground/70",
        TEXT_CLASS[block.type] ?? "text-base",
        block.type === "paragraph" &&
          "placeholder:text-transparent focus:placeholder:text-muted-foreground/70",
        block.type === "todo" && block.checked && "text-muted-foreground line-through",
      )}
    />
  );

  return (
    <div
      className={cn(
        "relative",
        block.type === "heading1" && "pt-5",
        block.type === "heading2" && "pt-3",
      )}
    >
      {block.type === "todo" ? (
        <div className="flex items-start gap-2.5">
          <span className="flex h-7 items-center">
            <Checkbox
              checked={block.checked === true}
              onCheckedChange={() => actions.toggle(block.id)}
              aria-label={block.checked ? "Mark as not done" : "Mark as done"}
            />
          </span>
          {textarea}
        </div>
      ) : block.type === "bullet" ? (
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="flex h-7 w-4 items-center justify-center text-muted-foreground"
          >
            •
          </span>
          {textarea}
        </div>
      ) : block.type === "callout" ? (
        <div className="flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2">
          <span className="flex h-7 items-center">
            <LightbulbIcon aria-hidden className="size-4 text-muted-foreground" />
          </span>
          {textarea}
        </div>
      ) : (
        textarea
      )}
      {menuOpen ? (
        <SpacesSlashMenu id={menuId} options={options} activeIndex={activeIndex} onPick={pick} />
      ) : null}
    </div>
  );
});
