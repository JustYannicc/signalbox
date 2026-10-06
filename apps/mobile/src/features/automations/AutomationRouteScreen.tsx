import { runActions, type RunAction } from "@t3tools/client-runtime/automations/list";
import { changePrompt } from "@t3tools/client-runtime/automations/prompts";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import {
  startsFromPayloadOnly,
  triggerSummary,
} from "@t3tools/client-runtime/automations/triggers";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AutomationDetail, EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { useOpenAgentDraft } from "./agent-draft";
import { useEnabledToggle, useMinuteClock, useStartRun } from "./automation-hooks";
import { AutomationDraftCard } from "./AutomationDraftCard";
import { GroupedCard, PillButton, RunStatusLine, SectionTitle } from "./AutomationParts";
import { AUTOMATION_CONTENT_STYLE } from "./AutomationsRouteScreen";

type AutomationRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly automationId: string;
};

export function AutomationRouteScreen({ route }: StaticScreenProps<AutomationRouteParams>) {
  const { environmentId, automationId } = route.params;
  const insets = useSafeAreaInsets();
  const detail = useEnvironmentQuery(
    automationState.detail({ environmentId, input: { automationId } }),
  );
  const automation = detail.data?.automation ?? null;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-screen"
      contentContainerClassName="gap-6 px-4 pt-3"
      contentContainerStyle={[
        AUTOMATION_CONTENT_STYLE,
        { paddingBottom: Math.max(insets.bottom, 18) + 18 },
      ]}
    >
      <NativeStackScreenOptions options={{ title: automation?.name ?? "Automation" }} />
      {detail.error ? (
        <Text className="px-2 text-base text-danger-foreground">{detail.error}</Text>
      ) : automation === null || detail.data === null ? (
        <Text className="px-2 text-base text-foreground-muted">Loading…</Text>
      ) : (
        <AutomationContent environmentId={environmentId} detail={detail.data} />
      )}
    </ScrollView>
  );
}

function AutomationContent(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: AutomationDetail;
}) {
  const { environmentId, detail } = props;
  const { automation, runs } = detail;
  // Only a draft so far: nothing to run or turn on until it's published.
  const unpublished = automation.version === 0;
  const navigation = useNavigation();
  const toggle = useEnabledToggle(environmentId, automation);
  const remove = useAtomCommand(automationState.remove, {
    label: "automation delete",
    reportFailure: false,
  });
  const { starting, start } = useStartRun(environmentId);
  const openDraft = useOpenAgentDraft();
  const now = useMinuteClock();
  // An automation only webhooks or events start leads with replaying its latest
  // run, the one web's diagram shows by default, so only then is its input loaded.
  const latestRunId = startsFromPayloadOnly(automation) ? (runs[0]?.id ?? null) : null;
  const latestRun = useEnvironmentQuery(
    latestRunId === null
      ? null
      : automationState.run({ environmentId, input: { runId: latestRunId } }),
  );
  const { lead, extra } = runActions(automation, latestRun.data);
  const hasSchedule = automation.triggers.some((trigger) => "cron" in trigger);
  const status = unpublished
    ? "Not published yet"
    : !toggle.value
      ? "Paused"
      : automation.nextRunAt
        ? formatNextScheduledTaskRun(automation.nextRunAt, now)
        : hasSchedule
          ? "Not scheduled"
          : "Only when it's triggered";

  const startRun = (action: RunAction) => void start(automation.id, action.input);

  const confirmDelete = () =>
    Alert.alert("Delete automation?", `${automation.name} stops running. You can't undo this.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const result = await remove({ environmentId, input: { automationId: automation.id } });
          if (result._tag === "Success") {
            if (navigation.canGoBack()) navigation.goBack();
            else navigation.dispatch(StackActions.replace("Automations"));
          } else if (!isAtomCommandInterrupted(result)) {
            Alert.alert("Couldn't delete it", String(squashAtomCommandFailure(result)));
          }
        },
      },
    ]);

  return (
    <>
      {automation.description ? (
        <Text className="px-2 text-base leading-normal text-foreground" selectable>
          {automation.description}
        </Text>
      ) : null}
      {automation.intent ? (
        <Text className="px-2 text-sm leading-normal text-foreground-muted" selectable>
          {`Asked for: “${automation.intent}”`}
        </Text>
      ) : null}

      <GroupedCard>
        <DetailRow label="Runs" value={triggerSummary(automation.triggers)} />
        <DetailRow label="Status" value={status} border />
        <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-2">
          <Text className="flex-1 text-lg text-foreground">{toggle.value ? "On" : "Paused"}</Text>
          <ThemedSwitch
            accessibilityLabel="Automation on"
            disabled={unpublished}
            value={toggle.value}
            onValueChange={toggle.set}
          />
        </View>
      </GroupedCard>

      {detail.draft ? (
        <AutomationDraftCard
          environmentId={environmentId}
          automation={automation}
          draft={detail.draft}
          liveSource={detail.source}
        />
      ) : null}

      <View className="gap-2">
        {!unpublished ? (
          <PillButton
            tone="primary"
            size="lg"
            icon={lead.id === "replay" ? "arrow.uturn.backward" : "play"}
            // This screen's "this run" is the latest one.
            label={starting ? "Starting…" : lead.id === "replay" ? "Replay latest run" : lead.title}
            disabled={starting}
            onPress={() => startRun(lead)}
          />
        ) : null}
        {extra && !unpublished ? (
          <PillButton
            size="lg"
            icon={extra.id === "replay" ? "arrow.uturn.backward" : "play"}
            label={extra.title}
            disabled={starting}
            onPress={() => startRun(extra)}
          />
        ) : null}
        <PillButton
          size="lg"
          icon="square.and.pencil"
          label="Change with agent"
          onPress={() =>
            void openDraft(
              { environmentId, projectId: automation.projectId },
              changePrompt(automation),
            )
          }
        />
      </View>

      <View className="gap-2">
        <SectionTitle>Recent runs</SectionTitle>
        <GroupedCard>
          {runs.length === 0 ? (
            <Text className="p-4 text-base text-foreground-muted">No runs yet.</Text>
          ) : (
            runs.map((run, index) => (
              <Pressable
                key={run.id}
                accessibilityRole="button"
                onPress={() =>
                  navigation.navigate("AutomationRun", { environmentId, runId: run.id })
                }
                className={
                  index === 0
                    ? "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                    : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
                }
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {runTitle(run)}
                  </Text>
                  <RunStatusLine run={run} showTrigger />
                  {/* Untitled failures already lead with their error. */}
                  {run.error && run.title ? (
                    <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                      {run.error}
                    </Text>
                  ) : null}
                </View>
                <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
              </Pressable>
            ))
          )}
        </GroupedCard>
      </View>

      <View className="gap-3 px-2">
        <Pressable
          accessibilityRole="button"
          onPress={confirmDelete}
          className="self-start py-2 active:opacity-70"
        >
          <Text className="text-base font-t3-medium text-danger-foreground">Delete automation</Text>
        </Pressable>
      </View>
    </>
  );
}

function DetailRow(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly border?: boolean;
}) {
  return (
    <View
      className={
        props.border
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={2}>
        {props.value}
      </Text>
    </View>
  );
}
