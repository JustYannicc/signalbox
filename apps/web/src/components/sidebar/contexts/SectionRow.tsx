import { type SectionNode, sectionNudgeFor } from "@t3tools/client-runtime/state/signalboxContexts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  FolderPlusIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { SIGNALBOX_SECTION_NAME_MAX_LENGTH } from "@t3tools/contracts/signalboxContexts";
import { type DragEvent, type KeyboardEvent, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { SidebarMenuButton } from "../../ui/sidebar";
import { dropKindAt, SECTION_DRAG_MIME, useSectionTree } from "./sectionTree";

/** Indent per nesting level, on top of the row's own inset. */
const DEPTH_INDENT_REM = 0.875;

/** Enter saves, Escape cancels, leaving the field saves; each ends the rename once. */
function RenameInput(props: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(props.initial);
  // Enter and Escape unmount the field, and that unmount still fires blur.
  const doneRef = useRef(false);
  const finish = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    props.onDone(name);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    // Enter that confirms an IME candidate isn't a save.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  };
  return (
    <input
      aria-label="Section name"
      autoFocus
      maxLength={SIGNALBOX_SECTION_NAME_MAX_LENGTH}
      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm text-sidebar-foreground outline-none"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

export function SectionRow(props: { node: SectionNode; depth: number }) {
  const tree = useSectionTree();
  const { section, children } = props.node;
  const hasChildren = children.length > 0;
  const expanded = hasChildren && !tree.collapsed.has(section.id);
  const renaming = tree.renamingId === section.id;
  const indicator = tree.dropIndicator?.targetKey === section.id ? tree.dropIndicator.kind : null;
  const nudge = (direction: Parameters<typeof sectionNudgeFor>[2]) =>
    sectionNudgeFor(tree.snapshot, section.id, direction);

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (tree.draggingId === null) return;
    const kind = dropKindAt(event, expanded);
    if (!tree.dropMove({ kind, targetId: section.id })) {
      if (indicator !== null) tree.setDropIndicator(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (indicator !== kind) tree.setDropIndicator({ targetKey: section.id, kind });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = tree.dropMove({ kind: dropKindAt(event, expanded), targetId: section.id });
    tree.setDropIndicator(null);
    tree.setDraggingId(null);
    // Dropping inside a folded section shows where it went.
    if (move?.parentId === section.id && tree.collapsed.has(section.id)) {
      tree.toggleFold(section.id);
    }
    void tree.moveSection(move);
  };

  return (
    <li className="relative">
      <div
        className={cn(
          "group/section-row relative rounded-md",
          indicator === "inside" && "bg-sidebar-row-hover ring-1 ring-primary/50 ring-inset",
          tree.draggingId === section.id && "opacity-50",
        )}
        draggable={!renaming}
        onDragStart={(event) => {
          event.dataTransfer.setData(SECTION_DRAG_MIME, section.id);
          event.dataTransfer.effectAllowed = "move";
          tree.setDraggingId(section.id);
        }}
        onDragEnd={() => {
          tree.setDraggingId(null);
          tree.setDropIndicator(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            tree.setDropIndicator(null);
          }
        }}
        onDrop={onDrop}
      >
        {indicator === "before" || indicator === "after" ? (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
              indicator === "before" ? "-top-0.5" : "-bottom-0.5",
            )}
          />
        ) : null}
        <SidebarMenuButton
          render={renaming ? <div /> : undefined}
          aria-expanded={hasChildren ? expanded : undefined}
          onClick={() => {
            if (hasChildren && !renaming) tree.toggleFold(section.id);
          }}
          onDoubleClick={() => {
            if (!renaming) tree.setRenamingId(section.id);
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "F2") tree.setRenamingId(section.id);
          }}
          style={{
            paddingInlineStart: `calc(var(--sidebar-row-content-inset) + ${props.depth * DEPTH_INDENT_REM}rem)`,
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
              expanded && "rotate-90",
              !hasChildren && "invisible",
            )}
          />
          <FolderIcon className="size-3.5" />
          {renaming ? (
            <RenameInput
              initial={section.name}
              onDone={(name) =>
                name === null ? tree.setRenamingId(null) : void tree.renameSection(section.id, name)
              }
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
              {section.name}
            </span>
          )}
          <span aria-hidden className="w-5 shrink-0" />
        </SidebarMenuButton>
        {renaming ? null : (
          <div className="absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/section-row:opacity-100 group-focus-within/section-row:opacity-100 has-[[data-popup-open]]:opacity-100 max-sm:opacity-100">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Section options for ${section.name}`}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="start" side="right">
                <MenuItem onClick={() => void tree.createSection(section.contextId, section.id)}>
                  <FolderPlusIcon />
                  New subsection
                </MenuItem>
                <MenuItem onClick={() => tree.setRenamingId(section.id)}>
                  <PencilIcon />
                  Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  disabled={!nudge("up")}
                  onClick={() => void tree.moveSection(nudge("up"))}
                >
                  <ArrowUpIcon />
                  Move up
                </MenuItem>
                <MenuItem
                  disabled={!nudge("down")}
                  onClick={() => void tree.moveSection(nudge("down"))}
                >
                  <ArrowDownIcon />
                  Move down
                </MenuItem>
                <MenuItem
                  disabled={!nudge("indent")}
                  onClick={() => void tree.moveSection(nudge("indent"))}
                >
                  <IndentIncreaseIcon />
                  Move into section above
                </MenuItem>
                <MenuItem
                  disabled={!nudge("outdent")}
                  onClick={() => void tree.moveSection(nudge("outdent"))}
                >
                  <IndentDecreaseIcon />
                  Move out of parent
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => void tree.deleteSection(section.id)}>
                  <Trash2Icon />
                  {hasChildren ? "Delete, keep subsections" : "Delete"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        )}
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-px">
          {children.map((child) => (
            <SectionRow key={child.section.id} node={child} depth={props.depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
