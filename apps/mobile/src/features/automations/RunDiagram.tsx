import { diagramRun } from "@t3tools/client-runtime/automations/diagram";
import { RUN_TRIGGER_LABEL } from "@t3tools/client-runtime/automations/labels";
import { layoutWorkflow } from "@t3tools/client-runtime/automations/layout";
import { DISPLAY_STATUS_LABEL, runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { triggerSummary } from "@t3tools/client-runtime/automations/triggers";
import {
  workflowNodeIdForStepKey,
  type Automation,
  type AutomationRunDetail,
  type AutomationWaitingQuestion,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { StatusDot } from "./AutomationParts";
import { STATUS_TEXT_CLASS } from "./presentation";
import { RunStateButton } from "./RunStateButton";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowDiagram } from "./WorkflowDiagram";

/** Room the floating run bar takes over the bottom of the diagram. */
const RUN_BAR_CLEARANCE = 96;

/** One run drawn over its automation, pannable, with how it went floating below. */
export function RunDiagram(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: AutomationRunDetail;
  readonly automation: Automation | null;
  readonly waiting: ReadonlyArray<AutomationWaitingQuestion>;
}) {
  const { environmentId, detail, automation } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const trigger =
    (detail.run.trigger === "cron" || detail.run.trigger === "event") && automation
      ? triggerSummary(
          automation.triggers.filter((entry) =>
            detail.run.trigger === "cron" ? "cron" in entry : "on" in entry,
          ),
        )
      : RUN_TRIGGER_LABEL[detail.run.trigger];
  // Every live update brings a new graph object for the same graph, so lay out
  // once per version and trigger text rather than per update.
  const layoutKey = `${detail.run.automationId}:${detail.run.version}:${trigger}`;
  const [laidOut, setLaidOut] = useState(() => ({
    key: layoutKey,
    layout: layoutWorkflow(detail.graph, trigger),
  }));
  const current =
    laidOut.key === layoutKey
      ? laidOut
      : { key: layoutKey, layout: layoutWorkflow(detail.graph, trigger) };
  if (current !== laidOut) setLaidOut(current);
  const { layout } = current;
  const diagram = useMemo(() => diagramRun(layout, detail.graph, detail), [layout, detail]);
  const focusCard = diagram.focus
    ? layout.cards.find((card) => card.id === diagram.focus?.id)
    : undefined;
  const runId = detail.run.id;
  const openStep = useCallback(
    (nodeId: string) => navigation.navigate("AutomationRunStep", { environmentId, runId, nodeId }),
    [navigation, environmentId, runId],
  );
  const question = props.waiting[0];

  return (
    <View className="flex-1">
      <WorkflowCanvas
        contentWidth={layout.width}
        contentHeight={layout.height}
        focusY={focusCard ? focusCard.y + focusCard.height / 2 : null}
        bottomInset={RUN_BAR_CLEARANCE + insets.bottom}
      >
        <WorkflowDiagram layout={layout} run={diagram} onPressStep={openStep} />
      </WorkflowCanvas>
      <RunBar
        environmentId={environmentId}
        detail={detail}
        latestVersion={automation?.version ?? null}
        onAnswer={question ? () => openStep(workflowNodeIdForStepKey(question.stepKey)) : undefined}
      />
    </View>
  );
}

/** How the run went, floating over the diagram, with the one action that fits its state. */
function RunBar(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: AutomationRunDetail;
  readonly latestVersion: number | null;
  readonly onAnswer: (() => void) | undefined;
}) {
  const { run } = props.detail;
  const insets = useSafeAreaInsets();
  const status = runDisplayStatus(run);

  return (
    <View
      className="absolute inset-x-4 gap-1.5 rounded-[22px] border border-border bg-card px-4 py-3"
      style={{ bottom: Math.max(insets.bottom, 12) + 4 }}
    >
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <StatusDot status={status} size="md" />
          <Text
            className={cn("text-base font-t3-bold", STATUS_TEXT_CLASS[status])}
            numberOfLines={1}
          >
            {DISPLAY_STATUS_LABEL[status]}
          </Text>
          <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
            {RUN_TRIGGER_LABEL[run.trigger]} · {relativeTime(run.finishedAt ?? run.startedAt)}
          </Text>
        </View>
        <RunStateButton
          environmentId={props.environmentId}
          run={run}
          latestVersion={props.latestVersion}
          onAnswer={props.onAnswer}
        />
      </View>
      {run.error ? (
        <Text className="text-sm text-danger-foreground" numberOfLines={3} selectable>
          {run.error}
        </Text>
      ) : null}
    </View>
  );
}
