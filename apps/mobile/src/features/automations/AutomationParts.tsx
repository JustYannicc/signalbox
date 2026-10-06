import {
  DISPLAY_STATUS_LABEL,
  runDisplayStatus,
  type AutomationDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import { RUN_TRIGGER_LABEL } from "@t3tools/client-runtime/automations/labels";
import type { AutomationRunSummary } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { STATUS_DOT_CLASS, STATUS_TEXT_CLASS } from "./presentation";

export function StatusDot(props: {
  readonly status: AutomationDisplayStatus;
  readonly size?: "sm" | "md";
}) {
  return (
    <View
      className={cn(
        "shrink-0 rounded-full",
        props.size === "md" ? "size-2.5" : "size-2",
        STATUS_DOT_CLASS[props.status],
      )}
    />
  );
}

/** Marks an automation whose code ships with Signalbox. */
export function BuiltInPill() {
  return (
    <StatusPill
      label="Built-in"
      size="compact"
      pillClassName="bg-subtle"
      textClassName="text-foreground-secondary"
    />
  );
}

/** "Failed · 3h" with the state's color, for rows that summarize a run. */
export function RunStatusLine(props: {
  readonly run: AutomationRunSummary;
  readonly showTrigger?: boolean;
}) {
  const status = runDisplayStatus(props.run);
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      <StatusDot status={status} />
      <Text className={cn("text-sm font-t3-medium", STATUS_TEXT_CLASS[status])} numberOfLines={1}>
        {DISPLAY_STATUS_LABEL[status]}
      </Text>
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        {props.showTrigger ? ` · ${RUN_TRIGGER_LABEL[props.run.trigger]}` : ""} ·{" "}
        {relativeTime(props.run.startedAt)}
      </Text>
    </View>
  );
}

/** Rounded grouped surface used for every block on the automation screens. */
export function GroupedCard(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <View
      className={cn(
        "overflow-hidden rounded-[24px] border-continuous bg-grouped-card",
        props.className,
      )}
    >
      {props.children}
    </View>
  );
}

export function SectionTitle(props: { readonly children: string; readonly trailing?: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between gap-3 px-2">
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.children}</Text>
      {props.trailing}
    </View>
  );
}

const PILL_SIZE = {
  /** Inline actions: Stop, Retry, a choice's options, Open thread. */
  sm: { frame: "min-h-9 px-4", label: "text-sm", icon: 15 },
  /** An ask's answer buttons. */
  md: { frame: "min-h-11 min-w-20 px-5", label: "text-base", icon: 16 },
  /** A screen's full-width actions. */
  lg: { frame: "min-h-12 px-5", label: "text-base", icon: 16 },
} as const;

/**
 * Every pill button on the automation screens. Not MaterialButton: these need
 * an icon, a bordered secondary look, and three sizes. `selected` makes a radio
 * or checkbox pill report its state; the caller picks its tone.
 */
export function PillButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "primary" | "secondary";
  readonly size?: keyof typeof PILL_SIZE;
  readonly icon?: AppSymbolName;
  readonly accessibilityRole?: "button" | "link" | "radio" | "checkbox";
  readonly selected?: boolean;
  readonly disabled?: boolean;
  /** Fades the pill; defaults to `disabled`. A pill sending its own answer stays solid. */
  readonly dimmed?: boolean;
}) {
  const primary = props.tone === "primary";
  const size = PILL_SIZE[props.size ?? "sm"];
  const role = props.accessibilityRole ?? "button";
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={props.label}
      accessibilityState={{
        disabled,
        ...(role === "radio" ? { selected: props.selected === true } : {}),
        ...(role === "checkbox" ? { checked: props.selected === true } : {}),
      }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full active:opacity-70",
        size.frame,
        primary ? "bg-primary" : "border border-secondary-border bg-secondary",
        (props.dimmed ?? disabled) && "opacity-60",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={size.icon}
          tintColorClassName={primary ? "accent-primary-foreground" : "accent-icon"}
        />
      ) : null}
      <Text
        className={cn(
          "font-t3-bold",
          size.label,
          primary ? "text-primary-foreground" : "text-secondary-foreground",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
