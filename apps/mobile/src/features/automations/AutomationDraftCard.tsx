import { foldUnchanged, lineDiff } from "@t3tools/client-runtime/automations/sourceDiff";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { Automation, AutomationDraft, EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { automationState } from "../../state/automations";
import { useAtomCommand } from "../../state/use-atom-command";
import { GroupedCard, PillButton, SectionTitle } from "./AutomationParts";

/**
 * A pending draft on the automation screen: what it changes against the live
 * version, either side's code, and Publish / Discard. A never-published
 * automation has only its draft, so it shows that and offers Publish alone.
 */

type DraftView = "changes" | "draft" | "live";

const VIEW_OPTIONS = [
  { value: "changes", label: "Changes" },
  { value: "draft", label: "Draft" },
  { value: "live", label: "Live" },
] as const satisfies ReadonlyArray<{ value: DraftView; label: string }>;

export function AutomationDraftCard(props: {
  readonly environmentId: EnvironmentId;
  readonly automation: Automation;
  readonly draft: AutomationDraft;
  /** The live version's source. */
  readonly liveSource: string;
}) {
  const { environmentId, automation, draft } = props;
  const published = automation.version > 0;
  const [view, setView] = useState<DraftView>(published ? "changes" : "draft");
  const options = { label: "automation draft", reportFailure: false };
  const publish = useAtomCommand(automationState.publish, options);
  const discard = useAtomCommand(automationState.discardDraft, options);
  const [busy, setBusy] = useState(false);
  const input = { automationId: automation.id };

  const runPublish = async () => {
    setBusy(true);
    void Haptics.selectionAsync();
    const result = await publish({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (!isAtomCommandInterrupted(result)) {
      Alert.alert("Couldn't publish the draft", String(squashAtomCommandFailure(result)));
    }
  };

  const confirmDiscard = () =>
    Alert.alert("Discard the draft?", `Version ${automation.version} keeps running.`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const result = await discard({ environmentId, input });
          setBusy(false);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            Alert.alert("Couldn't discard the draft", String(squashAtomCommandFailure(result)));
          }
        },
      },
    ]);

  return (
    <View className="gap-2">
      <SectionTitle>{`Draft · version ${draft.version}`}</SectionTitle>
      <GroupedCard>
        <View className="gap-1 px-4 py-3">
          <Text className="text-lg text-foreground">
            {published ? "Not live yet" : "Not published yet"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {published
              ? `Runs use version ${automation.version} until you publish. Saved ${relativeTime(draft.savedAt)} ago.`
              : `It won't run until you publish it. Saved ${relativeTime(draft.savedAt)} ago.`}
          </Text>
        </View>
        {published ? (
          <View className="border-t border-border-subtle px-3 py-2">
            <SegmentedControl
              options={VIEW_OPTIONS}
              selected={view}
              onSelect={setView}
              role="tab"
              size="compact"
            />
          </View>
        ) : null}
        <View className="border-t border-border-subtle py-3">
          {view === "changes" ? (
            <DiffLines before={props.liveSource} after={draft.source} />
          ) : (
            <CodeLines source={view === "live" ? props.liveSource : draft.source} />
          )}
        </View>
      </GroupedCard>
      <PillButton
        tone="primary"
        size="lg"
        icon="arrow.up.circle"
        label={busy ? "Working…" : "Publish"}
        disabled={busy}
        onPress={() => void runPublish()}
      />
      {published ? (
        <PillButton
          size="lg"
          icon="xmark"
          label="Discard draft"
          disabled={busy}
          onPress={confirmDiscard}
        />
      ) : null}
    </View>
  );
}

function CodeLines(props: { readonly source: string }) {
  const lines = useMemo(
    () =>
      props.source
        .replace(/\n$/, "")
        .split("\n")
        .map((text, index) => ({ number: index + 1, text })),
    [props.source],
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="px-4">
        {lines.map((line) => (
          <Text
            key={line.number}
            selectable
            className="font-mono text-2xs leading-relaxed text-foreground"
          >
            {line.text || " "}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function DiffLines(props: { readonly before: string; readonly after: string }) {
  const rows = useMemo(
    () => foldUnchanged(lineDiff(props.before, props.after)),
    [props.before, props.after],
  );
  if (!rows.some((row) => row.kind === "added" || row.kind === "removed")) {
    return (
      <Text className="px-4 text-sm text-foreground-muted">
        The draft's code is the same as the live version's.
      </Text>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {rows.map((row) =>
          row.kind === "gap" ? (
            <Text
              key={`gap-${row.from}`}
              className="px-4 py-0.5 font-mono text-2xs text-foreground-muted"
            >
              {`⋯ ${row.count} unchanged ${row.count === 1 ? "line" : "lines"}`}
            </Text>
          ) : (
            <Text
              key={`${row.before ?? ""}:${row.after ?? ""}`}
              selectable
              className={cn(
                "px-4 font-mono text-2xs leading-relaxed",
                row.kind === "added" &&
                  "bg-adaptive-emerald-600-400/10 text-adaptive-emerald-600-400",
                row.kind === "removed" && "bg-adaptive-rose-600-400/10 text-adaptive-rose-600-400",
                row.kind === "same" && "text-foreground",
              )}
            >
              {`${row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "} ${row.text}`}
            </Text>
          ),
        )}
      </View>
    </ScrollView>
  );
}
