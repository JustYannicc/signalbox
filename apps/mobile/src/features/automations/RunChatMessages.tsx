import {
  agentThreadId,
  CONTAINER_TYPE_LABEL,
  durationMs,
  stepTypeLabel,
} from "@t3tools/client-runtime/automations/labels";
import {
  findWorkflowNode,
  passSummary,
  resultLine,
  type RunPass,
} from "@t3tools/client-runtime/automations/runs";
import {
  DISPLAY_STATUS_LABEL,
  stepDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import {
  workflowNodeIdForStepKey,
  type AutomationStep,
  type AutomationWaitingQuestion,
  type EnvironmentId,
  type WorkflowGraph,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { AskAnswer } from "./AskAnswer";
import { StatusDot } from "./AutomationParts";
import { STATUS_TEXT_CLASS } from "./presentation";
import { ErrorDetails } from "./RunDiagnostics";
import { ServiceLogo } from "./ServiceLogo";

/**
 * The messages of a run's chat: one per step that ran, and one per loop with
 * its passes. A step says what it is, how long it took, how it went and what
 * it came back with in a line; a waiting question carries its answer buttons,
 * and an agent step opens the thread that did the work. Mirrors web's
 * RunChatMessages.
 */

/** Passes shown before "Show all"; an `each` over hundreds of items stays cheap. */
const PASS_PREVIEW_COUNT = 10;

export const MESSAGE_TILE_SIZE = 32;

/** Questions waiting in this run, by step key, so a step can carry its answer buttons. */
export type QuestionsByStep = ReadonlyMap<string, AutomationWaitingQuestion>;

function StatusText(props: { readonly step: Pick<AutomationStep, "status" | "verb"> }) {
  const status = stepDisplayStatus(props.step);
  return (
    <View className="flex-row items-center gap-1.5">
      <StatusDot status={status} />
      <Text className={cn("text-sm font-t3-medium", STATUS_TEXT_CLASS[status])}>
        {DISPLAY_STATUS_LABEL[status]}
      </Text>
    </View>
  );
}

export function StepMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: WorkflowGraph;
  readonly step: AutomationStep;
  readonly questions: QuestionsByStep;
}) {
  const { step } = props;
  const navigation = useNavigation();
  const node = findWorkflowNode(props.graph.nodes, workflowNodeIdForStepKey(step.key));
  const service = node?.type === "step" ? node.service : undefined;
  const ms = durationMs(step);
  const waitingAsk = step.verb === "ask" && step.status === "waiting";
  const line = step.error !== null || waitingAsk ? null : resultLine(step.result);
  const question = waitingAsk ? props.questions.get(step.key) : undefined;
  const threadId = agentThreadId(step);
  const meta = [
    stepTypeLabel({ verb: step.verb, service }),
    ms !== null ? formatDuration(ms) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View className="flex-row gap-3">
      <ServiceLogo verb={step.verb} service={service} size={MESSAGE_TILE_SIZE} />
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-t3-medium text-foreground" selectable>
          {step.label}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <StatusText step={step} />
          <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
            {meta}
          </Text>
        </View>
        {step.error ? (
          <ErrorDetails error={step.error} detail={step.errorDetail} numberOfLines={6} />
        ) : line ? (
          <Text
            className="text-sm leading-normal text-foreground-muted"
            numberOfLines={3}
            selectable
          >
            {line}
          </Text>
        ) : null}
        {question ? (
          <View className="pt-2">
            <AskAnswer
              environmentId={props.environmentId}
              question={question}
              showQuestion={question.question !== null}
            />
          </View>
        ) : null}
        {threadId ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() =>
              navigation.navigate("Thread", { environmentId: props.environmentId, threadId })
            }
            className="flex-row items-center gap-1.5 self-start py-1 active:opacity-60"
          >
            <SymbolView name="text.bubble" size={13} tintColorClassName="accent-icon-muted" />
            <Text className="text-sm font-t3-medium text-foreground-muted">Open thread</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** A pass needs to stay open when something in it is waiting on you or failed. */
function passNeedsLook(pass: RunPass) {
  return pass.steps.some((step) => step.status === "failed" || step.status === "waiting");
}

function PassRow(props: {
  readonly pass: RunPass;
  readonly max: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const summary = passSummary(props.pass);
  const status = stepDisplayStatus(summary.step);
  const title = `Pass ${props.pass.index + 1}${props.max ? ` / ${props.max}` : ""}`;
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${DISPLAY_STATUS_LABEL[status]}`}
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        className="min-h-9 flex-row items-center gap-2 active:opacity-60"
      >
        <SymbolView
          name={props.open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="text-sm font-t3-medium text-foreground">{title}</Text>
        <StatusDot status={status} />
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {props.open ? "" : (summary.line ?? "")}
        </Text>
        {summary.durationMs !== null ? (
          <Text className="text-sm text-foreground-muted tabular-nums">
            {formatDuration(summary.durationMs)}
          </Text>
        ) : null}
      </Pressable>
      {props.open ? <View className="gap-4 pl-5">{props.children}</View> : null}
    </View>
  );
}

export function LoopMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: WorkflowGraph;
  readonly nodeId: string;
  readonly passes: ReadonlyArray<RunPass>;
  readonly questions: QuestionsByStep;
}) {
  const node = findWorkflowNode(props.graph.nodes, props.nodeId);
  const loop = node?.type === "loop" ? node : null;
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? props.passes : props.passes.slice(0, PASS_PREVIEW_COUNT);
  const last = props.passes.at(-1)?.index;
  // Few passes read best open; many start folded except the ones worth a look.
  const openByDefault = (pass: RunPass) =>
    props.passes.length <= 3 || pass.index === last || passNeedsLook(pass);
  const count = props.passes.length === 1 ? "1 pass" : `${props.passes.length} passes`;

  return (
    <View className="flex-row gap-3">
      <View
        className="items-center justify-center rounded-[9px] border border-border-subtle bg-card"
        style={{ width: MESSAGE_TILE_SIZE, height: MESSAGE_TILE_SIZE }}
      >
        <SymbolView name="arrow.clockwise" size={18} tintColorClassName="accent-icon-muted" />
      </View>
      <View className="min-w-0 flex-1 gap-2">
        <View className="gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" selectable>
            {loop?.label.text ?? "Loop"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {loop ? CONTAINER_TYPE_LABEL[loop.verb] : "Loop"} · {count}
          </Text>
        </View>
        <View className="gap-1 rounded-2xl border border-border-subtle px-3 py-2">
          {shown.map((pass) => (
            <PassRow
              key={pass.index}
              pass={pass}
              max={loop?.verb === "repeat" ? loop.max : undefined}
              open={openByDefault(pass) !== toggled.has(pass.index)}
              onToggle={() =>
                setToggled((current) => {
                  const next = new Set(current);
                  if (!next.delete(pass.index)) next.add(pass.index);
                  return next;
                })
              }
            >
              {pass.steps.map((step) => (
                <StepMessage
                  key={step.key}
                  environmentId={props.environmentId}
                  graph={props.graph}
                  step={step}
                  questions={props.questions}
                />
              ))}
            </PassRow>
          ))}
          {props.passes.length > PASS_PREVIEW_COUNT ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowAll((value) => !value)}
              className="min-h-9 justify-center active:opacity-60"
            >
              <Text className="text-sm font-t3-medium text-foreground-muted">
                {showAll ? "Show less" : `Show ${props.passes.length - PASS_PREVIEW_COUNT} more`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
