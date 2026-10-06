import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  automationSubtitle,
  entryKey,
  sortAutomations,
  type AutomationSortOrder,
} from "@t3tools/client-runtime/automations/list";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import type { Automation, EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { relativeTime } from "../../lib/time";
import { useHeaderMenu } from "../../native/HeaderMenu";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { useNewAutomationDraft } from "./agent-draft";
import { useEnabledToggle, useMinuteClock } from "./automation-hooks";
import {
  useAutomationLists,
  waitingAutomations,
  type EnvironmentAutomations,
  type WaitingAutomation,
} from "./automation-data";
import { AskAnswer } from "./AskAnswer";
import { GroupedCard, PillButton, SectionTitle, StatusDot } from "./AutomationParts";

/** Content width on wide panes; rows past this get hard to scan. */
export const AUTOMATION_CONTENT_STYLE = {
  width: "100%",
  maxWidth: 720,
  alignSelf: "center",
} as const;

/** The list's order for this app session, like web's sort menu. */
const sortOrderAtom = Atom.make<AutomationSortOrder>("attention").pipe(Atom.keepAlive);

const SORT_OPTIONS: ReadonlyArray<{ value: AutomationSortOrder; title: string }> = [
  { value: "attention", title: "Needs you, then recent" },
  { value: "name", title: "Name" },
];

/**
 * Every automation across connected environments. Questions waiting on you
 * come first and can be answered right here.
 */
export function AutomationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const lists = useAutomationLists();
  const waiting = waitingAutomations(lists);
  const loaded = lists.filter((list) => list.automations !== null || list.error !== null);
  const total = lists.reduce((sum, list) => sum + (list.automations?.length ?? 0), 0);
  const showEnvironment = lists.length > 1;
  const sortOrder = useAtomValue(sortOrderAtom);
  const setSortOrder = useAtomSet(sortOrderAtom);
  const now = useMinuteClock();
  const environmentIds = useMemo(
    () => new Set(lists.map((list) => list.environment.environmentId)),
    [lists],
  );
  const entries = useMemo(
    () =>
      lists.flatMap((list) =>
        (list.automations ?? []).map((automation) => ({
          environmentId: list.environment.environmentId,
          automation,
        })),
      ),
    [lists],
  );
  const newAutomation = useNewAutomationDraft(entries, environmentIds);
  useHeaderMenu({
    title: "Sort by",
    icon: "line.3.horizontal.decrease.circle",
    buttons: newAutomation
      ? [{ accessibilityLabel: "New automation", icon: "plus", onPress: newAutomation }]
      : [],
    groups: [
      {
        id: "sort",
        actions: SORT_OPTIONS.map((option) => ({
          id: `sort:${option.value}`,
          title: option.title,
          selected: sortOrder === option.value,
          onPress: () => setSortOrder(option.value),
        })),
      },
    ],
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-screen"
      contentContainerClassName="gap-6 px-4 pt-3"
      contentContainerStyle={[
        AUTOMATION_CONTENT_STYLE,
        { paddingBottom: Math.max(insets.bottom, 18) + 18 },
      ]}
    >
      {lists.length === 0 ? (
        <Text className="px-2 text-base text-foreground-muted">
          Connect an environment to see its automations.
        </Text>
      ) : null}

      {waiting.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Waiting on you</SectionTitle>
          {waiting.map((entry) => (
            <WaitingCard key={entryKey(entry)} entry={entry} />
          ))}
        </View>
      ) : null}

      {lists.map((list) =>
        list.automations?.length === 0 ? null : (
          <EnvironmentSection
            key={list.environment.environmentId}
            list={list}
            showEnvironment={showEnvironment}
            sortOrder={sortOrder}
            now={now}
          />
        ),
      )}

      {lists.length > 0 && loaded.length === lists.length && total === 0 ? (
        <View className="gap-4 px-2">
          <Text className="text-base leading-normal text-foreground-muted">
            Automations do recurring work for you and check in when they need a decision. Describe
            one to an agent and it builds it.
          </Text>
          {newAutomation ? (
            <PillButton
              tone="primary"
              size="lg"
              icon="plus"
              label="New automation"
              onPress={newAutomation}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function EnvironmentSection(props: {
  readonly list: EnvironmentAutomations;
  readonly showEnvironment: boolean;
  readonly sortOrder: AutomationSortOrder;
  readonly now: number;
}) {
  const { environment, error } = props.list;
  const entries = useMemo(
    () =>
      props.list.automations === null
        ? null
        : sortAutomations(
            props.list.automations.map((automation) => ({
              environmentId: environment.environmentId,
              automation,
            })),
            props.sortOrder,
          ),
    [environment.environmentId, props.list.automations, props.sortOrder],
  );
  return (
    <View className="gap-2">
      {props.showEnvironment ? <SectionTitle>{environment.label}</SectionTitle> : null}
      <GroupedCard>
        {error ? (
          <Text className="p-4 text-base text-danger-foreground">{error}</Text>
        ) : entries === null ? (
          <Text className="p-4 text-base text-foreground-muted">Loading automations…</Text>
        ) : (
          entries.map(({ automation }, index) => (
            <AutomationRow
              key={automation.id}
              environmentId={environment.environmentId}
              automation={automation}
              first={index === 0}
              now={props.now}
            />
          ))
        )}
      </GroupedCard>
    </View>
  );
}

function AutomationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly automation: Automation;
  readonly first: boolean;
  readonly now: number;
}) {
  const { automation, environmentId } = props;
  const navigation = useNavigation();
  const toggle = useEnabledToggle(environmentId, automation);

  return (
    <View
      className={
        props.first
          ? "flex-row items-center gap-3 px-4 py-3.5"
          : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3.5"
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={automation.name}
        onPress={() =>
          navigation.navigate("Automation", { environmentId, automationId: automation.id })
        }
        className="min-w-0 flex-1 gap-1 active:opacity-70"
      >
        <Text
          className={
            automation.enabled
              ? "text-lg font-t3-medium text-foreground"
              : "text-lg font-t3-medium text-foreground-muted"
          }
          numberOfLines={1}
        >
          {automation.name}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {automationSubtitle(automation, (iso) => formatNextScheduledTaskRun(iso, props.now))}
        </Text>
        {automation.lastRun ? (
          <View className="min-w-0 flex-row items-center gap-1.5">
            <StatusDot status={runDisplayStatus(automation.lastRun)} />
            <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
              {runTitle(automation.lastRun)} · {relativeTime(automation.lastRun.startedAt)}
            </Text>
          </View>
        ) : (
          <Text className="text-sm text-foreground-muted">Hasn't run yet</Text>
        )}
      </Pressable>
      <ThemedSwitch
        accessibilityLabel={`${automation.name} on`}
        value={toggle.value}
        onValueChange={toggle.set}
      />
    </View>
  );
}

function WaitingCard(props: { readonly entry: WaitingAutomation }) {
  const { environmentId, automation, question: first } = props.entry;
  const navigation = useNavigation();

  return (
    <GroupedCard className="gap-4 p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open the ${automation.name} run`}
        onPress={() => navigation.navigate("AutomationRun", { environmentId, runId: first.runId })}
        className="flex-row items-center gap-2 active:opacity-70"
      >
        <StatusDot status="needsYou" size="md" />
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
          {automation.name}
        </Text>
        <Text className="text-sm text-foreground-muted">{relativeTime(first.since)}</Text>
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
      </Pressable>
      {automation.waiting.map((question) => (
        <AskAnswer
          key={`${question.runId}:${question.stepKey}`}
          environmentId={environmentId}
          question={question}
        />
      ))}
    </GroupedCard>
  );
}
