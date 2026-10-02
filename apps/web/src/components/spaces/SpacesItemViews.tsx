/**
 * The library body in its two shapes: a dense ledger (default) and a grid of
 * excerpt cards for skimming. Both select into the same preview panel.
 */
import { BotIcon, PinIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SpacesItemFixture } from "./spacesFixtures";
import { ItemTypeIcon, SourceMark } from "./SpacesGlyphs";
import { findSource, formatAge, itemConnector, SPACES_TYPE_LABEL } from "./spacesModel";
import { sectionName } from "./spacesSpace";

interface ItemViewProps {
  items: readonly SpacesItemFixture[];
  selectedId: string | undefined;
  onSelect: (itemId: string) => void;
  /** The open space; items from any other section carry that section's name. */
  spaceId: string;
}

const sectionLabel = (item: SpacesItemFixture, spaceId: string) =>
  item.space === spaceId ? undefined : sectionName(item.space);

function SectionLabel(props: { label: string | undefined }) {
  if (!props.label) return null;
  return <span className="shrink-0 text-xs text-muted-foreground">{props.label}</span>;
}

const LEDGER_COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_8.5rem_3rem] items-center gap-4 md:grid-cols-[minmax(0,1fr)_9rem_minmax(0,11rem)_3.5rem_3rem]";

function UsedInChats(props: { count: number }) {
  if (props.count === 0) return <span className="text-muted-foreground/50">–</span>;
  const label = `Used in ${props.count} ${props.count === 1 ? "chat" : "chats"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1 text-muted-foreground" />}
        aria-label={label}
      >
        <BotIcon aria-hidden className="size-3.5" />
        <span className="tabular-nums">{props.count}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const LedgerRow = memo(function LedgerRow(props: {
  item: SpacesItemFixture;
  sectionLabel: string | undefined;
  selected: boolean;
  onSelect: (itemId: string) => void;
}) {
  const { item } = props;
  const source = findSource(item.source);
  return (
    <li>
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(item.id)}
        className={cn(
          LEDGER_COLUMNS,
          "h-11 w-full cursor-pointer rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent",
          props.selected && "bg-accent",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <ItemTypeIcon type={item.type} className="text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{item.name}</span>
          {item.pinned ? (
            <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <SectionLabel label={props.sectionLabel} />
        </span>
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <SourceMark connector={itemConnector(item)} />
          <span className="truncate">{source?.name}</span>
        </span>
        <span className="hidden truncate text-muted-foreground md:block">{item.location}</span>
        <span className="hidden text-xs md:block">
          <UsedInChats count={item.usedInChats} />
        </span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {formatAge(item.updatedAt)}
        </span>
      </button>
    </li>
  );
});

export function SpacesLedger(props: ItemViewProps) {
  return (
    <div className="flex flex-col">
      <div
        aria-hidden
        className={cn(
          LEDGER_COLUMNS,
          "border-b border-border px-2.5 pb-2 text-xs font-medium text-muted-foreground",
        )}
      >
        <span>Name</span>
        <span>Source</span>
        <span className="hidden md:block">Location</span>
        <span className="hidden md:block">Used</span>
        <span className="text-right">Updated</span>
      </div>
      <ul aria-label="Items" className="flex flex-col gap-px pt-1">
        {props.items.map((item) => (
          <LedgerRow
            key={item.id}
            item={item}
            sectionLabel={sectionLabel(item, props.spaceId)}
            selected={item.id === props.selectedId}
            onSelect={props.onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

export function SpacesGrid(props: ItemViewProps) {
  return (
    <ul aria-label="Items" className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {props.items.map((item) => {
        const selected = item.id === props.selectedId;
        return (
          <li key={item.id} className="flex">
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => props.onSelect(item.id)}
              className={cn(
                "flex w-full cursor-pointer flex-col gap-3 rounded-lg border bg-card p-3.5 text-left outline-none hover:border-ring/40 focus-visible:border-ring",
                selected ? "border-ring" : "border-border",
              )}
            >
              <span className="flex items-start gap-2">
                <ItemTypeIcon type={item.type} className="mt-0.5 text-muted-foreground" />
                <span className="line-clamp-2 text-sm font-medium text-foreground">
                  {item.name}
                </span>
              </span>
              <span className="line-clamp-4 flex-1 text-xs leading-relaxed text-muted-foreground">
                {item.excerpt}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <SourceMark connector={itemConnector(item)} />
                <span className="min-w-0 flex-1 truncate">
                  {sectionLabel(item, props.spaceId) ?? SPACES_TYPE_LABEL[item.type]}
                </span>
                <span className="tabular-nums">{formatAge(item.updatedAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
