import { runActions } from "@t3tools/client-runtime/automations/list";
import { changePrompt } from "@t3tools/client-runtime/automations/prompts";
import type {
  Automation,
  AutomationRunDetail,
  AutomationWaitingQuestion,
  EnvironmentId,
} from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useHeaderMenu, type HeaderMenuAction } from "../../native/HeaderMenu";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { useOpenAgentDraft } from "./agent-draft";
import { useCustomize, useStartRun } from "./automation-hooks";
import { AutomationRunChat } from "./AutomationRunChat";
import { RunDiagram } from "./RunDiagram";
import { RunStateButton } from "./RunStateButton";

export type RunView = "run" | "diagram";

type RunRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  /** Opens as the chat-like log unless the diagram is asked for, like web. */
  readonly view?: RunView;
};

const VIEW_OPTIONS = [
  { value: "run", label: "Run" },
  { value: "diagram", label: "Diagram" },
] as const satisfies ReadonlyArray<{ value: RunView; label: string }>;

const NO_QUESTIONS: ReadonlyArray<AutomationWaitingQuestion> = [];

export function AutomationRunRouteScreen({ route }: StaticScreenProps<RunRouteParams>) {
  const { environmentId, runId } = route.params;
  const [view, setView] = useState<RunView>(route.params.view === "diagram" ? "diagram" : "run");
  const run = useEnvironmentQuery(automationState.run({ environmentId, input: { runId } }));
  const automationId = run.data?.run.automationId ?? null;
  const detail = useEnvironmentQuery(
    automationId === null
      ? null
      : automationState.detail({ environmentId, input: { automationId } }),
  );
  const automation = detail.data?.automation ?? null;
  const allWaiting = automation?.waiting;
  const waiting = useMemo(
    () => allWaiting?.filter((question) => question.runId === runId) ?? NO_QUESTIONS,
    [allWaiting, runId],
  );
  useRunActionsMenu(environmentId, automation, run.data);

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: automation?.name ?? "Run" }} />
      {run.error ? (
        <Text className="p-6 text-base text-danger-foreground">{run.error}</Text>
      ) : run.data === null ? (
        <Text className="p-6 text-base text-foreground-muted">Loading the run…</Text>
      ) : (
        <>
          <View className="px-4 pb-1 pt-3">
            <SegmentedControl
              options={VIEW_OPTIONS}
              selected={view}
              onSelect={setView}
              role="tab"
              size="compact"
            />
          </View>
          {view === "run" ? (
            <AutomationRunChat
              environmentId={environmentId}
              detail={run.data}
              version={automation?.version ?? null}
              waiting={waiting}
              trailing={
                <RunStateButton
                  environmentId={environmentId}
                  run={run.data.run}
                  latestVersion={automation?.version ?? null}
                />
              }
            />
          ) : (
            <RunDiagram
              environmentId={environmentId}
              detail={run.data}
              automation={automation}
              waiting={waiting}
            />
          )}
        </>
      )}
    </View>
  );
}

/** The header's run menu: Run now or Replay by web's rules, and Change with agent (Customize, for a built-in). */
function useRunActionsMenu(
  environmentId: EnvironmentId,
  automation: Automation | null,
  detail: AutomationRunDetail | null,
) {
  const { starting, start } = useStartRun(environmentId);
  const openDraft = useOpenAgentDraft();
  const { customizing, customize } = useCustomize(environmentId, automation);
  const actions = automation ? runActions(automation, detail) : null;
  const runMenu = (actions ? [actions.lead, actions.extra] : []).flatMap(
    (action): HeaderMenuAction[] =>
      action && automation
        ? [
            {
              id: action.id,
              title: action.title,
              icon: action.id === "replay" ? "arrow.uturn.backward" : "play",
              disabled: starting,
              onPress: () => void start(automation.id, action.input),
            },
          ]
        : [],
  );
  useHeaderMenu({
    title: "Automation actions",
    icon: "ellipsis.circle",
    groups: automation
      ? [
          { id: "run", actions: runMenu },
          {
            id: "agent",
            actions: [
              automation.builtIn
                ? {
                    id: "customize",
                    title: "Customize",
                    icon: "square.and.pencil",
                    disabled: customizing,
                    onPress: customize,
                  }
                : {
                    id: "change",
                    title: "Change with agent",
                    icon: "square.and.pencil",
                    onPress: () =>
                      void openDraft(
                        { environmentId, projectId: automation.projectId },
                        changePrompt(automation),
                      ),
                  },
            ],
          },
        ]
      : [],
  });
}
