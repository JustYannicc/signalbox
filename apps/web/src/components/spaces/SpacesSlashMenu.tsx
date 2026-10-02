/**
 * The "/" menu of the note editor: block types first, then library items to
 * link. The owning block keeps focus and drives it with the arrow keys.
 */
import {
  Heading1Icon,
  Heading2Icon,
  LightbulbIcon,
  ListIcon,
  PilcrowIcon,
  SquareCheckIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SpacesItemFixture } from "./spacesFixtures";
import { ItemTypeIcon } from "./SpacesGlyphs";
import { findSource } from "./spacesModel";
import type { NoteBlockType } from "./spacesNotes";

export type SlashOption =
  | { readonly kind: "block"; readonly type: NoteBlockType; readonly label: string }
  | { readonly kind: "link"; readonly item: SpacesItemFixture };

const BLOCK_OPTIONS: readonly { type: NoteBlockType; label: string; icon: LucideIcon }[] = [
  { type: "paragraph", label: "Text", icon: PilcrowIcon },
  { type: "heading1", label: "Heading", icon: Heading1Icon },
  { type: "heading2", label: "Subheading", icon: Heading2Icon },
  { type: "todo", label: "To-do", icon: SquareCheckIcon },
  { type: "bullet", label: "Bulleted list", icon: ListIcon },
  { type: "callout", label: "Callout", icon: LightbulbIcon },
];
const BLOCK_ICON = new Map(BLOCK_OPTIONS.map((option) => [option.type, option.icon]));
const LINK_LIMIT = 5;

export function slashOptions(
  query: string,
  items: readonly SpacesItemFixture[],
  excludeId: string,
): SlashOption[] {
  const needle = query.trim().toLowerCase();
  const blocks = BLOCK_OPTIONS.filter((option) => option.label.toLowerCase().includes(needle)).map(
    (option): SlashOption => ({ kind: "block", type: option.type, label: option.label }),
  );
  const links = items
    .filter((item) => item.id !== excludeId && item.name.toLowerCase().includes(needle))
    .slice(0, LINK_LIMIT)
    .map((item): SlashOption => ({ kind: "link", item }));
  return [...blocks, ...links];
}

export const slashOptionId = (menuId: string, index: number) => `${menuId}-option-${index}`;

export function SpacesSlashMenu(props: {
  id: string;
  options: readonly SlashOption[];
  activeIndex: number;
  onPick: (option: SlashOption) => void;
}) {
  const firstLink = props.options.findIndex((option) => option.kind === "link");
  return (
    <div
      id={props.id}
      role="listbox"
      aria-label="Insert"
      className="absolute top-full left-0 z-20 mt-1 flex max-h-72 w-72 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      {props.options.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No blocks or items match</p>
      ) : null}
      {props.options.map((option, index) => {
        const active = index === props.activeIndex;
        const heading =
          index === 0 && option.kind === "block"
            ? "Blocks"
            : index === firstLink
              ? "Link an item"
              : null;
        const Icon = option.kind === "block" ? BLOCK_ICON.get(option.type) : undefined;
        return (
          <div key={option.kind === "block" ? option.type : option.item.id}>
            {heading ? (
              <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                {heading}
              </div>
            ) : null}
            <div
              id={slashOptionId(props.id, index)}
              role="option"
              aria-selected={active}
              // Keep focus in the block's textarea while picking.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onPick(option)}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
                active && "bg-accent text-accent-foreground",
              )}
            >
              {option.kind === "block" ? (
                <>
                  {Icon ? <Icon aria-hidden className="size-4 text-muted-foreground" /> : null}
                  <span>{option.label}</span>
                </>
              ) : (
                <>
                  <ItemTypeIcon type={option.item.type} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{option.item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {findSource(option.item.source)?.name}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
