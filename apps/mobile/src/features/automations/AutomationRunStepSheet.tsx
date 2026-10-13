import { runQuestions } from "@t3tools/client-runtime/automations/ask";
import {
  agentThreadId,
  compactJson,
  stepTypeLabel,
} from "@t3tools/client-runtime/automations/labels";
import { findWorkflowNode, stepsForNode } from "@t3tools/client-runtime/automations/runs";
import {
  DISPLAY_STATUS_LABEL,
  stepDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import type {
  AutomationStep,
  AutomationWaitingQuestion,
  EnvironmentId,
  WorkflowStepNode,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { AskAnswer } from "./AskAnswer";
import { PillButton, StatusDot } from "./AutomationParts";
import { STATUS_TEXT_CLASS } from "./presentation";
import { ErrorDetails } from "./RunDiagnostics";
import { ServiceLogo } from "./ServiceLogo";

type StepSheetParams = {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly nodeId: string;
};

/** Loops run a step many times; past this, the sheet stops listing older runs. */
const MAX_LISTED = 20;

/** One diagram step in one run: how each of its runs went, with its thread and any open question. */
export function AutomationRunStepSheet({ route }: StaticScreenProps<StepSheetParams>) {
  const { environmentId, runId, nodeId } = route.params;
  const insets = useSafeAreaInsets();
  const run = useEnvironmentQuery(automationState.run({ environmentId, input: { runId } }));
  const automationId = run.data?.run.automationId ?? null;
  const detail = useEnvironmentQuery(
    automationId === null
      ? null
      : automationState.detail({ environmentId, input: { automationId } }),
  );
  const graphNode = run.data ? findWorkflowNode(run.data.graph.nodes, nodeId) : null;
  const node = graphNode?.type === "step" ? graphNode : null;
  const steps = useMemo(
    () => (run.data ? stepsForNode(run.data.steps, nodeId) : []),
    [run.data, nodeId],
  );
  const waiting = detail.data?.automation.waiting;
  const questions = useMemo(
    () => runQuestions(runId, steps, waiting ?? []),
    [runId, steps, waiting],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        className="flex-1"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-6"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
      >
        {run.error ? (
          <Text className="text-base text-danger-foreground">{run.error}</Text>
        ) : !run.data ? (
          <Text className="text-base text-foreground-muted">Loading…</Text>
        ) : node === null ? (
          <Text className="text-base text-foreground-muted">
            This step isn't in the automation anymore.
          </Text>
        ) : (
          <>
            <StepHeader node={node} />
            {steps.length === 0 ? (
              <Text className="text-base text-foreground-muted">
                {run.data.run.status === "running"
                  ? "This step hasn't run yet."
                  : "This step didn't run this time."}
              </Text>
            ) : (
              steps
                .slice(0, MAX_LISTED)
                .map((step) => (
                  <StepRun
                    key={step.key}
                    environmentId={environmentId}
                    step={step}
                    numbered={steps.length > 1}
                    question={questions.get(step.key) ?? null}
                  />
                ))
            )}
            {steps.length > MAX_LISTED ? (
              <Text className="text-sm text-foreground-muted">
                And {steps.length - MAX_LISTED} earlier runs of this step.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function StepHeader({ node }: { readonly node: WorkflowStepNode }) {
  return (
    <View className="flex-row items-center gap-3">
      <ServiceLogo verb={node.verb} service={node.service} size={40} />
      <View className="min-w-0 flex-1">
        <Text className="text-lg font-t3-bold text-foreground" numberOfLines={2}>
          {node.label.text}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {stepTypeLabel(node)}
        </Text>
      </View>
    </View>
  );
}

function StepRun(props: {
  readonly environmentId: EnvironmentId;
  readonly step: AutomationStep;
  readonly numbered: boolean;
  readonly question: AutomationWaitingQuestion | null;
}) {
  const { step } = props;
  const navigation = useNavigation();
  const status = stepDisplayStatus(step);
  const result =
    step.status === "succeeded" && step.result != null ? compactJson(step.result, 600) : null;
  const threadId = agentThreadId(step);

  return (
    <View className="gap-3 rounded-[20px] bg-grouped-card p-4">
      <View className="flex-row items-center gap-2">
        <StatusDot status={status} size="md" />
        <Text className={cn("text-base font-t3-medium", STATUS_TEXT_CLASS[status])}>
          {DISPLAY_STATUS_LABEL[status]}
        </Text>
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {props.numbered && step.label !== "" ? `${step.label} · ` : ""}
          {relativeTime(step.finishedAt ?? step.startedAt)}
        </Text>
      </View>

      {props.question ? (
        <AskAnswer environmentId={props.environmentId} question={props.question} />
      ) : null}

      {step.error ? <ErrorDetails error={step.error} detail={step.errorDetail} /> : null}

      {result ? (
        <Text
          className="rounded-xl bg-sheet p-3 font-mono text-xs leading-normal text-foreground"
          numberOfLines={14}
          selectable
        >
          {result}
        </Text>
      ) : null}

      {threadId ? (
        <View className="flex-row">
          <PillButton
            label="Open thread"
            icon="text.bubble"
            onPress={() => {
              void Haptics.selectionAsync();
              // The sheet is a leaf; the thread belongs in the workspace stack above the run.
              navigation.dispatch(
                StackActions.replace("Thread", { environmentId: props.environmentId, threadId }),
              );
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
