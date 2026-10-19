import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKindWithCapabilityFallback } from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { TaskLifecycleRecord, TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useThreadKind } from "../../state/signalboxThreadKinds";
import { TaskOutcomeText } from "./TaskOutcomeText";

const codeTaskCondition = {
  summary: "Merged and live",
  input: { type: "pullRequestsMergedAndLive", outcome: "Merged and live" },
};

function conditionEditorValue(record: TaskLifecycleRecord | null, hasPullRequest: boolean) {
  const condition = record?.condition ?? (hasPullRequest ? codeTaskCondition : null);
  const input = condition?.input;
  const editableInput =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "defaultProposal"))
      : input;
  return {
    summary: condition?.summary ?? "",
    input: editableInput === undefined ? "" : JSON.stringify(editableInput, null, 2),
  };
}

function decodeInput(value: string): { readonly value?: unknown; readonly error?: string } {
  if (value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        value: Object.fromEntries(
          Object.entries(parsed).filter(([key]) => key !== "defaultProposal"),
        ),
      };
    }
    return { value: parsed };
  } catch {
    return { error: "Enter valid JSON for the condition." };
  }
}

function failureMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim() ? error.message : "Try again.";
}

function settlementDescription(record: TaskLifecycleRecord | null) {
  if (record?.reason == null) return null;
  const reason = record.reason === "dropped" ? "Dropped" : "Marked done enough";
  return record.uncertain ? `${reason} · uncertain` : reason;
}

export function TaskLifecycleControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: EnvironmentThreadShell;
}) {
  const { environmentId, threadId, shell } = props;
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const threadKind = useThreadKind(environmentId, threadId);
  const kind = threadKindWithCapabilityFallback(
    serverConfig?.environment.capabilities.threadKinds,
    threadKind,
  );
  const runLifecycle = useAtomCommand(automationState.taskLifecycle, { reportFailure: false });
  const settleThread = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const settled =
    shell.archivedAt !== null || shell.settledAt !== null || shell.settledOverride === "settled";
  const automationList = useEnvironmentQuery(
    kind === "task" ? automationState.list({ environmentId, input: {} }) : null,
  );
  const [record, setRecord] = useState<TaskLifecycleRecord | null>(null);
  const [recordThreadKey, setRecordThreadKey] = useState<string | null>(null);
  const [lifecycleKind, setLifecycleKind] = useState<TaskLifecycleResult["kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [initialSummary, setInitialSummary] = useState("");
  const [inputText, setInputText] = useState("");
  const [initialInputText, setInitialInputText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const key = `${environmentId}:${threadId}`;
  const hasPullRequest = shell.pullRequests.length > 0;
  const recordReady = recordThreadKey === key;

  useEffect(() => {
    if (kind !== "task") return;
    let current = true;
    void (async () => {
      const result = await runLifecycle({ environmentId, input: { threadId, action: "read" } });
      if (!current) return;
      if (result._tag === "Failure") {
        setError(failureMessage(result.cause));
        return;
      }
      setError(null);
      setRecord(result.value.record);
      setLifecycleKind(result.value.kind);
      setRecordThreadKey(key);
    })();
    return () => {
      current = false;
    };
  }, [environmentId, key, kind, runLifecycle, threadId]);

  useEffect(() => {
    if (kind !== "task" || automationList.data === null || !recordReady) return;
    let current = true;
    void (async () => {
      const result = await runLifecycle({ environmentId, input: { threadId, action: "read" } });
      if (!current || result._tag === "Failure") return;
      setRecord(result.value.record);
      setLifecycleKind(result.value.kind);
      setRecordThreadKey(key);
    })();
    return () => {
      current = false;
    };
  }, [automationList.data, environmentId, key, kind, recordReady, runLifecycle, threadId]);

  const openEditor = () => {
    const value = conditionEditorValue(recordReady ? record : null, hasPullRequest);
    setSummary(value.summary);
    setInitialSummary(value.summary);
    setInputText(value.input);
    setInitialInputText(value.input);
    setAdvancedOpen(false);
    setEditorOpen(true);
  };

  const saveCondition = async () => {
    const parsed = decodeInput(inputText);
    const doneWhen = summary.trim();
    if (!doneWhen || parsed.error) return;
    const summaryChanged = doneWhen !== initialSummary.trim();
    const advancedChanged = inputText !== initialInputText;
    const summaryCondition = {
      type: "outcome",
      criteria: doneWhen,
      outcome: doneWhen,
    };
    const input = advancedChanged
      ? (parsed.value ?? summaryCondition)
      : summaryChanged
        ? summaryCondition
        : parsed.value;
    setBusy(true);
    setError(null);
    const result = await runLifecycle({
      environmentId,
      input: {
        threadId,
        action: "propose",
        summary: doneWhen,
        automationId: record?.condition?.automationId ?? "builtin:task-done",
        ...(input === undefined ? {} : { input }),
        expectedGeneration: record?.generation ?? 0,
        expectedUpdatedAt: shell.updatedAt,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result.cause));
      return;
    }
    setRecord(result.value.record);
    setLifecycleKind(result.value.kind);
    setRecordThreadKey(key);
    if (!result.value.applied) {
      setError(
        "This task changed while you were editing. Review the latest condition and try again.",
      );
      return;
    }
    setEditorOpen(false);
  };

  const reopen = async () => {
    setBusy(true);
    setError(null);
    const result = await runLifecycle({ environmentId, input: { threadId, action: "reopen" } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result.cause));
      return;
    }
    setRecord(result.value.record);
    setLifecycleKind(result.value.kind);
    setRecordThreadKey(key);
    if (!result.value.applied)
      setError("This task changed while you were reopening it. Try again.");
  };

  const settle = async () => {
    setBusy(true);
    setError(null);
    const result = await settleThread({ environmentId, input: { threadId } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result.cause));
      return;
    }
    const refreshed = await runLifecycle({ environmentId, input: { threadId, action: "read" } });
    if (refreshed._tag === "Success") {
      setRecord(refreshed.value.record);
      setLifecycleKind(refreshed.value.kind);
      setRecordThreadKey(key);
    }
  };

  if (kind !== "task" || !recordReady || lifecycleKind !== "task") return null;
  const currentRecord = recordReady ? record : null;
  const displayedOutcome =
    [currentRecord?.outcome, settlementDescription(currentRecord)]
      .filter((value): value is string => Boolean(value))
      .join(" · ") || null;
  const conditionError = decodeInput(inputText).error;

  return (
    <>
      <View className="min-h-12 flex-row items-center gap-2 border-b border-border-subtle bg-screen px-4 py-1">
        <View className="min-w-0 flex-1">
          <Text className="text-2xs text-foreground-muted">Done when</Text>
          <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {recordReady
              ? (currentRecord?.condition?.summary ?? "No completion condition")
              : "Loading…"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            currentRecord?.condition ? "Edit done condition" : "Set done condition"
          }
          accessibilityState={{ disabled: !canOperate || busy }}
          className="min-h-11 justify-center px-2 active:opacity-60"
          disabled={!canOperate || busy}
          onPress={openEditor}
        >
          <Text className="text-sm font-t3-medium text-primary-text">Edit</Text>
        </Pressable>
        {settled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reopen task"
            accessibilityState={{ disabled: !canOperate || busy, busy }}
            className="min-h-11 justify-center px-2 active:opacity-60"
            disabled={!canOperate || busy}
            onPress={() => void reopen()}
          >
            <Text className="text-sm font-t3-medium text-primary-text">Reopen</Text>
          </Pressable>
        ) : supportsSettlement ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settle task"
            accessibilityState={{ disabled: !canOperate || busy, busy }}
            className="min-h-11 justify-center px-2 active:opacity-60"
            disabled={!canOperate || busy}
            onPress={() => void settle()}
          >
            <Text className="text-sm font-t3-medium text-primary-text">Settle</Text>
          </Pressable>
        ) : null}
      </View>
      {displayedOutcome || error ? (
        <View className="gap-1 bg-screen px-4 pb-2">
          {displayedOutcome ? (
            <TaskOutcomeText className="text-xs text-foreground-muted" text={displayedOutcome} />
          ) : null}
          {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
        </View>
      ) : null}
      {editorOpen ? (
        <Sheet title="Done when" onClose={() => setEditorOpen(false)}>
          <View className="flex-1 gap-4 px-5 py-5">
            <Text className="text-sm text-foreground-muted">
              Describe the result that should be true before this task is done. A folder agent
              checks it after the task’s work finishes.
            </Text>
            <View className="gap-1.5">
              <Text className="text-sm font-t3-medium text-foreground">Done when</Text>
              <TextInput
                accessibilityLabel="Done when"
                accessibilityHint="A folder agent checks this description after the task’s work finishes."
                className="min-h-12 rounded-xl border border-border bg-grouped-card px-3 text-base text-foreground"
                editable={!busy}
                maxLength={240}
                onChangeText={setSummary}
                placeholder="The requested change is working"
                value={summary}
              />
            </View>
            <View className="gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: advancedOpen }}
                className="min-h-11 flex-row items-center gap-1 active:opacity-60"
                onPress={() => setAdvancedOpen((open) => !open)}
              >
                <SymbolView
                  name={advancedOpen ? "chevron.down" : "chevron.right"}
                  size={12}
                  tintColorClassName="accent-icon-subtle"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-medium text-foreground-muted">
                  Advanced condition (optional)
                </Text>
              </Pressable>
              {advancedOpen ? (
                <View className="min-h-40 flex-1 gap-1.5">
                  <Text className="text-sm font-t3-medium text-foreground">Condition JSON</Text>
                  <Text className="text-xs text-foreground-muted">
                    Use JSON to wait for an event, date, or source, or combine conditions. It takes
                    precedence over the description above.
                  </Text>
                  <TextInput
                    accessibilityLabel="Condition JSON"
                    accessibilityHint={
                      conditionError ?? "An optional condition Signalbox evaluates for this task."
                    }
                    className="min-h-40 flex-1 rounded-xl border border-border bg-grouped-card px-3 py-3 font-mono text-xs leading-5 text-foreground"
                    editable={!busy}
                    multiline
                    onChangeText={setInputText}
                    placeholder={'{\n  "type": "event",\n  "on": "pr.merged"\n}'}
                    scrollEnabled
                    textAlignVertical="top"
                    value={inputText}
                  />
                  {conditionError ? (
                    <Text className="text-xs text-danger-foreground">{conditionError}</Text>
                  ) : null}
                </View>
              ) : null}
              {!advancedOpen && conditionError ? (
                <Text className="text-xs text-danger-foreground">
                  Open the advanced condition to fix the JSON.
                </Text>
              ) : null}
            </View>
            <Button
              disabled={!canOperate || busy || !summary.trim() || conditionError !== undefined}
              label={busy ? "Saving…" : "Save"}
              loading={busy}
              fullWidth
              onPress={() => void saveCondition()}
            />
          </View>
        </Sheet>
      ) : null}
    </>
  );
}
