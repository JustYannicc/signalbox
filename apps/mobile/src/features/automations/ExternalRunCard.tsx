import { durationMs } from "@t3tools/client-runtime/automations/labels";
import { externalDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { EXTERNAL_RUN_SYSTEM_NAMES, type ExternalRun } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { PillButton, StatusDot } from "./AutomationParts";

function timing(entry: { readonly startedAt: string | null; readonly finishedAt: string | null }) {
  const ms = durationMs(entry);
  return ms === null ? null : formatDuration(ms);
}

/** The run in another system a step started (GitHub Actions): its jobs and steps, and a way there. */
export function ExternalRunCard({ run }: { readonly run: ExternalRun }) {
  return (
    <View className="gap-3 rounded-xl bg-sheet p-3">
      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
        <Text className="text-sm font-t3-medium text-foreground">
          {EXTERNAL_RUN_SYSTEM_NAMES[run.system]}
        </Text>
        {`  ${run.scope}`}
      </Text>
      {run.jobs.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          {run.status === "queued" ? "Waiting for a runner…" : "No jobs yet."}
        </Text>
      ) : (
        run.jobs.map((job) => (
          <View key={job.id} className="gap-1.5">
            <View className="flex-row items-center gap-2">
              <StatusDot status={externalDisplayStatus(job.status)} />
              <Text
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {job.name}
              </Text>
              <Text className="text-xs text-foreground-muted">{timing(job) ?? ""}</Text>
            </View>
            {job.steps.map((step) => (
              <View key={step.id} className="flex-row items-center gap-2 ps-4">
                <StatusDot status={externalDisplayStatus(step.status)} />
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {step.name}
                </Text>
                <Text className="text-xs text-foreground-muted">{timing(step) ?? ""}</Text>
              </View>
            ))}
            {job.logTail ? (
              <Text
                className="rounded-lg bg-grouped-card p-2 font-mono text-[11px] leading-normal text-foreground"
                numberOfLines={12}
                selectable
              >
                {job.logTail.split("\n").slice(-12).join("\n")}
              </Text>
            ) : null}
          </View>
        ))
      )}
      {run.url ? (
        <View className="flex-row">
          <PillButton
            label="Open on GitHub"
            icon="arrow.up.right"
            accessibilityRole="link"
            onPress={() => {
              const url = run.url!;
              void tryOpenExternalUrl(url, "markdown-link").then((opened) => {
                if (!opened) Alert.alert("Couldn't open the link", url);
              });
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
