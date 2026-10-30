import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitOptionLooks } from "@t3tools/shared/askKit";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AskOptionLabel } from "./AskChoices";

const MODIFIERS = [restrictToVerticalAxis];

function RankedOption(props: {
  readonly id: string;
  readonly position: number;
  readonly count: number;
  readonly label: string;
  readonly look: AskKitOptionLooks[number] | undefined;
  readonly disabled: boolean;
  readonly onMove: (to: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border border-border bg-background py-1 ps-1 pe-1.5 text-sm",
        isDragging && "relative z-10 shadow-md/10",
      )}
    >
      <button
        type="button"
        aria-label={`Drag ${props.label}`}
        disabled={props.disabled}
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.position + 1}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 wrap-anywhere">
        <AskOptionLabel label={props.label} look={props.look} />
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${props.label} up`}
        disabled={props.disabled || props.position === 0}
        onClick={() => props.onMove(props.position - 1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${props.label} down`}
        disabled={props.disabled || props.position === props.count - 1}
        onClick={() => props.onMove(props.position + 1)}
      >
        <ArrowDownIcon />
      </Button>
    </li>
  );
}

/**
 * Shown in the options' own order until the person ranks them. Any move ranks them; so does
 * "Keep this order" when the shown order is already the answer. Reset returns to unranked.
 */
export function AskRanking(props: {
  readonly label: string;
  readonly options: SignalboxAskQuestion["options"];
  readonly looks: AskKitOptionLooks;
  readonly order: ReadonlyArray<number> | undefined;
  readonly disabled: boolean;
  readonly onChange: (order: ReadonlyArray<number> | undefined) => void;
}) {
  const order = props.order ?? props.options.map((_, index) => index);
  const ids = order.map(String);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = (from: number, to: number) => props.onChange(arrayMove([...order], from, to));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };
  return (
    <div className="flex flex-col gap-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol aria-label={props.label} className="flex flex-col gap-1">
            {order.map((option, position) => (
              <RankedOption
                key={option}
                id={String(option)}
                position={position}
                count={order.length}
                label={props.options[option]?.label ?? ""}
                look={props.looks[option]}
                disabled={props.disabled}
                onMove={(to) => move(position, to)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
        {props.order === undefined ? (
          <>
            <span>Not ranked yet.</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.disabled}
              onClick={() => props.onChange(order)}
            >
              Keep this order
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={props.disabled}
            onClick={() => props.onChange(undefined)}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
