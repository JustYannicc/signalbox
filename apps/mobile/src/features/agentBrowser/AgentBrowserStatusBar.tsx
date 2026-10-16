import type { AgentBrowserControl } from "@t3tools/contracts/signalboxPreviews";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";

const CONTROL_DOT = {
  agent: "bg-icon-muted",
  you: "bg-primary",
  "someone-else": "bg-warning-foreground",
} as const;

/** The one control the bar offers right now. */
export type AgentBrowserBarAction =
  | { readonly kind: "live"; readonly onPress: () => void }
  | { readonly kind: "take"; readonly disabled: boolean; readonly onPress: () => void }
  | { readonly kind: "hand-back"; readonly onPress: () => void };

/**
 * Who drives the agent's tab and what else is true right now, or which step
 * shows; with Take over, Hand back, or Live beside it.
 */
export function AgentBrowserStatusBar(props: {
  /** Set while a picked step shows instead of the live page. */
  readonly step: { readonly index: number; readonly count: number } | null;
  readonly control: AgentBrowserControl | null;
  readonly controlLabel: string | null;
  readonly detail: string | null;
  readonly action: AgentBrowserBarAction | null;
}) {
  const { action } = props;
  return (
    <View className="min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-4 pb-2">
      <View accessibilityRole="text" className="min-w-0 flex-1 flex-row items-center gap-1.5">
        {props.step !== null ? (
          <AppText textRole="footnote" numberOfLines={1} className="text-foreground">
            Step {props.step.index + 1} of {props.step.count}
          </AppText>
        ) : (
          <>
            {props.controlLabel !== null && props.control !== null ? (
              <>
                <View
                  className={cn("size-1.5 shrink-0 rounded-full", CONTROL_DOT[props.control])}
                />
                <AppText textRole="footnote" numberOfLines={1} className="shrink-0 text-foreground">
                  {props.controlLabel}
                </AppText>
              </>
            ) : null}
            {props.detail !== null ? (
              <AppText
                textRole="footnote"
                numberOfLines={1}
                className="min-w-0 shrink text-foreground-muted"
              >
                {props.controlLabel !== null ? "· " : null}
                {props.detail}
              </AppText>
            ) : null}
          </>
        )}
      </View>
      {action === null ? null : action.kind === "live" ? (
        <ControlPill variant="pill" label="Live" onPress={action.onPress} />
      ) : action.kind === "hand-back" ? (
        <ControlPill variant="primary" label="Hand back" onPress={action.onPress} />
      ) : (
        <ControlPill
          variant="pill"
          label="Take over"
          disabled={action.disabled}
          onPress={action.onPress}
        />
      )}
    </View>
  );
}
