/**
 * A notification decision, kept in the chat so skipped pings stay traceable:
 * one muted line ("Didn't notify you · …"), expandable to the reasoning.
 */
import { BellOffIcon, ChevronDownIcon, LaptopIcon, SmartphoneIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { CLIENT_DEVICES } from "../devices/devicesFixtures";
import type { AssistantBlock, ChatFixture, NotificationDelivery } from "./assistantFixtures";

export type NotificationBlock = Extract<AssistantBlock, { kind: "notification" }>;

export interface NotificationDecision extends NotificationBlock {
  readonly at: string;
}

/** Every notification decision in a chat, for the trace panel. */
export function chatNotifications(chat: ChatFixture): NotificationDecision[] {
  return chat.turns.flatMap((turn) =>
    turn.blocks.flatMap((block) =>
      block.kind === "notification" ? [{ ...block, at: turn.at }] : [],
    ),
  );
}

const deviceName = (kind: "laptop" | "phone", fallback: string) =>
  CLIENT_DEVICES.find((device) => device.kind === kind)?.name ?? fallback;

export const DELIVERY_ICON = {
  none: BellOffIcon,
  computer: LaptopIcon,
  phone: SmartphoneIcon,
} as const;

/** "Didn't notify you", "Badged on your MacBook Pro", "Pushed to Pixel 8 Pro". */
export function deliveryLabel(delivery: NotificationDelivery): string {
  if (delivery === "computer") return `Badged on your ${deviceName("laptop", "computer")}`;
  if (delivery === "phone") return `Pushed to ${deviceName("phone", "your phone")}`;
  return "Didn't notify you";
}

export function notificationSummary(notice: NotificationBlock): string {
  return `${deliveryLabel(notice.delivery)} · ${notice.reason}`;
}

export function NotificationRow(props: { notice: NotificationBlock; at?: string }) {
  const { notice } = props;
  const Icon = DELIVERY_ICON[notice.delivery];
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "group/notice flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
          notice.delivery === "none" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{notificationSummary(notice)}</span>
        {props.at ? <span className="shrink-0 tabular-nums">{props.at}</span> : null}
        <ChevronDownIcon
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-panel-open/notice:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <p className="px-2 pt-0.5 pb-1.5 ps-7.5 text-xs leading-relaxed text-muted-foreground">
          {notice.detail}
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
}
