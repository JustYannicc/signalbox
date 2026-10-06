import { runQuestions } from "@t3tools/client-runtime/automations/ask";
import { durationMs, RUN_TRIGGER_LABEL } from "@t3tools/client-runtime/automations/labels";
import { resultLine, runChatItems, runTitle } from "@t3tools/client-runtime/automations/runs";
import { DISPLAY_STATUS_LABEL, runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import type {
  AutomationRunDetail,
  AutomationRunTrigger,
  AutomationWaitingQuestion,
  EnvironmentId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useMemo, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolViewProps } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { StatusDot } from "./AutomationParts";
import { AUTOMATION_CONTENT_STYLE } from "./AutomationsRouteScreen";
import { STATUS_TEXT_CLASS } from "./presentation";
import { LoopMessage, MESSAGE_TILE_SIZE, StepMessage } from "./RunChatMessages";
import { ErrorDetails, RunLogs } from "./RunDiagnostics";

const TRIGGER_SYMBOL: Record<AutomationRunTrigger, AppSymbolViewProps["name"]> = {
  manual: "play",
  cron: "clock",
  webhook: "link",
  automation: "bolt.circle",
  event: "bolt.horizontal.circle",
};

type EdgeTone = "neutral" | "success" | "error";

/** The first and last messages: how the run started and how it ended. */
function EdgeMessage(props: {
  readonly icon: AppSymbolViewProps["name"];
  readonly tone?: EdgeTone;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  const tone = props.tone ?? "neutral";
  return (
    <View className="flex-row gap-3">
      <View
        className="items-center justify-center rounded-[9px] border border-border-subtle bg-card"
        style={{ width: MESSAGE_TILE_SIZE, height: MESSAGE_TILE_SIZE }}
      >
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={
            tone === "error"
              ? "accent-adaptive-rose-600-400"
              : tone === "success"
                ? "accent-adaptive-emerald-600-400"
                : "accent-icon-muted"
          }
        />
      </View>
      <View className="min-w-0 flex-1 gap-1 pt-1">
        <Text className="text-base font-t3-medium text-foreground">{props.title}</Text>
        {props.children}
      </View>
    </View>
  );
}

function EndMessage({ detail }: { readonly detail: AutomationRunDetail }) {
  const { run } = detail;
  switch (run.status) {
    case "running":
      return run.waitingOnYou ? null : <EdgeMessage icon="circle" title="Still running" />;
    case "succeeded": {
      const output = resultLine(detail.output);
      return (
        <EdgeMessage icon="checkmark.circle" tone="success" title="Finished">
          {output ? (
            <Text className="text-sm leading-normal text-foreground-muted" selectable>
              {output}
            </Text>
          ) : null}
        </EdgeMessage>
      );
    }
    case "failed":
      return (
        <EdgeMessage icon="exclamationmark.circle" tone="error" title="Failed">
          {run.error ? (
            <ErrorDetails error={run.error} detail={run.errorDetail} numberOfLines={8} />
          ) : null}
        </EdgeMessage>
      );
    case "cancelled":
      return <EdgeMessage icon="xmark.circle.fill" title="Cancelled" />;
  }
}

/**
 * A run as a chat: how it started, one message per step in the order they
 * ran (a loop's passes gathered where the loop ran), and how it ended. A
 * question waiting on you is answered right in its message; what the code
 * logged sits folded at the bottom.
 */
export function AutomationRunChat(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: AutomationRunDetail;
  /** The automation's current version, to flag a run of an earlier one. */
  readonly version: number | null;
  readonly waiting: ReadonlyArray<AutomationWaitingQuestion>;
  /** The run's state action: Stop while it's going, Retry once it failed. */
  readonly trailing?: ReactNode;
}) {
  const { detail, environmentId } = props;
  const { run } = detail;
  const insets = useSafeAreaInsets();
  const items = useMemo(() => runChatItems(detail.steps), [detail.steps]);
  const questions = useMemo(
    () => runQuestions(run.id, detail.steps, props.waiting),
    [run.id, detail.steps, props.waiting],
  );
  const status = runDisplayStatus(run);
  const ms = durationMs(run);
  const input = resultLine(detail.input);
  const meta = [
    RUN_TRIGGER_LABEL[run.trigger],
    relativeTime(run.startedAt),
    ms !== null ? formatDuration(ms) : null,
    props.version !== null && run.version !== props.version ? "earlier version" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ScrollView
      className="flex-1"
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-6 px-4 pt-4"
      contentContainerStyle={[
        AUTOMATION_CONTENT_STYLE,
        { paddingBottom: Math.max(insets.bottom, 18) + 18 },
      ]}
    >
      <View className="flex-row items-start gap-3 px-1">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-lg font-t3-bold text-foreground" selectable>
            {runTitle(run)}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <StatusDot status={status} />
            <Text className={cn("text-sm font-t3-medium", STATUS_TEXT_CLASS[status])}>
              {DISPLAY_STATUS_LABEL[status]}
            </Text>
            <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
              · {meta}
            </Text>
          </View>
        </View>
        {props.trailing}
      </View>

      <View className="gap-5">
        <EdgeMessage icon={TRIGGER_SYMBOL[run.trigger]} title={RUN_TRIGGER_LABEL[run.trigger]}>
          {input ? (
            <Text className="text-sm leading-normal text-foreground-muted" selectable>
              With {input}
            </Text>
          ) : null}
        </EdgeMessage>
        {items.map((item) =>
          item.kind === "step" ? (
            <StepMessage
              key={item.step.key}
              environmentId={environmentId}
              graph={detail.graph}
              step={item.step}
              questions={questions}
            />
          ) : (
            <LoopMessage
              key={item.key}
              environmentId={environmentId}
              graph={detail.graph}
              nodeId={item.nodeId}
              passes={item.passes}
              questions={questions}
            />
          ),
        )}
        <EndMessage detail={detail} />
      </View>
      <RunLogs logs={detail.logs} />
    </ScrollView>
  );
}
