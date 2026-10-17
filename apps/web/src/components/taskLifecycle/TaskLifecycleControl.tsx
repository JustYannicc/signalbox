import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { TaskLifecycleRecord, TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ArchiveRestoreIcon, CheckIcon, ChevronRightIcon, PencilIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { buildThreadRouteParams } from "../../threadRoutes";
import { threadKindWithCapabilityFallback } from "@t3tools/client-runtime/state/signalboxThreadKinds";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShell } from "../../state/entities";
import { useThreadKind } from "../../state/signalboxThreadKinds";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { automationState } from "../../state/automations";
import { Dialog } from "../ui/dialog";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { stackedThreadToast, toastManager } from "../ui/toast";

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

function failureDescription(result: { readonly _tag: string; readonly cause?: unknown }) {
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result as never);
    if (error instanceof Error && error.message.trim()) return error.message;
  }
  return "Try again.";
}

function settlementDescription(record: TaskLifecycleRecord | null): string | null {
  if (record?.reason === null || record?.reason === undefined) return null;
  const reason = record.reason === "dropped" ? "Dropped" : "Marked done enough";
  return record.uncertain ? `${reason} · uncertain` : reason;
}

export function TaskLifecycleControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell?: EnvironmentThreadShell | undefined;
  readonly presentation?: "details" | "recent" | undefined;
  readonly onReopen?: (() => void) | undefined;
}) {
  const { environmentId, threadId } = props;
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const liveShell = useThreadShell(threadRef);
  const shell = props.shell ?? liveShell;
  if (shell === null) return null;
  return <TaskLifecycleTaskRow {...props} shell={shell} />;
}

function TaskLifecycleTaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: EnvironmentThreadShell;
  readonly presentation?: "details" | "recent" | undefined;
  readonly onReopen?: (() => void) | undefined;
}) {
  const { environmentId, threadId, shell } = props;
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const threadKind = useThreadKind(threadRef, shell);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const runLifecycle = useAtomCommand(automationState.taskLifecycle, { reportFailure: false });
  const kind = threadKindWithCapabilityFallback(
    serverConfig?.environment.capabilities.threadKinds,
    threadKind?.kind ?? null,
  );
  const automationList = useEnvironmentQuery(
    kind === "task" ? automationState.list({ environmentId, input: {} }) : null,
  );
  const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const { settleThread } = useThreadActions();
  const [record, setRecord] = useState<TaskLifecycleRecord | null>(null);
  const [recordThreadKey, setRecordThreadKey] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [lifecycleKind, setLifecycleKind] = useState<TaskLifecycleResult["kind"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [initialSummary, setInitialSummary] = useState("");
  const [inputText, setInputText] = useState("");
  const [initialInputText, setInitialInputText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const key = `${environmentId}:${threadId}`;
  const recordReady = recordThreadKey === key;

  useEffect(() => {
    if (kind !== "task") return;
    let current = true;
    void (async () => {
      const result = await runLifecycle({ environmentId, input: { threadId, action: "read" } });
      if (!current) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setReadError(failureDescription(result));
        return;
      }
      setReadError(null);
      setRecord(result.value.record);
      setLifecycleKind(result.value.kind);
      setRecordThreadKey(key);
    })();
    return () => {
      current = false;
    };
  }, [environmentId, key, kind, runLifecycle, threadId]);

  useEffect(() => {
    if (kind !== "task" || automationList.dataUpdatedAt === 0 || recordThreadKey !== key) return;
    let current = true;
    void (async () => {
      const result = await runLifecycle({ environmentId, input: { threadId, action: "read" } });
      if (!current || result._tag !== "Success") return;
      setRecord(result.value.record);
      setLifecycleKind(result.value.kind);
      setRecordThreadKey(key);
    })();
    return () => {
      current = false;
    };
  }, [
    automationList.dataUpdatedAt,
    environmentId,
    key,
    kind,
    recordThreadKey,
    runLifecycle,
    threadId,
  ]);

  const currentRecord = recordReady ? record : null;
  const archived = shell.archivedAt !== null;
  const settled = shell.settledOverride === "settled";
  const editorError = decodeInput(inputText).error;
  const hasPullRequest = (shell?.pullRequests.length ?? 0) > 0;

  const openEditor = () => {
    const value = conditionEditorValue(currentRecord, hasPullRequest);
    setSummary(value.summary);
    setInitialSummary(value.summary);
    setInputText(value.input);
    setInitialInputText(value.input);
    setAdvancedOpen(false);
    setDialogOpen(true);
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
    setReadError(null);
    const result = await runLifecycle({
      environmentId,
      input: {
        threadId,
        action: "propose",
        summary: doneWhen,
        automationId: currentRecord?.condition?.automationId ?? "builtin:task-done",
        ...(input === undefined ? {} : { input }),
        expectedGeneration: currentRecord?.generation ?? 0,
        expectedUpdatedAt: shell.updatedAt,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setReadError(failureDescription(result));
      return;
    }
    if (!result.value.applied) {
      setRecord(result.value.record);
      setLifecycleKind(result.value.kind);
      setRecordThreadKey(key);
      setReadError(
        "This task changed while you were editing. Review the latest condition and try again.",
      );
      return;
    }
    setRecord(result.value.record);
    setLifecycleKind(result.value.kind);
    setRecordThreadKey(key);
    setDialogOpen(false);
  };

  const reopen = async () => {
    setBusy(true);
    setReadError(null);
    const result = await runLifecycle({ environmentId, input: { threadId, action: "reopen" } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setReadError(failureDescription(result));
      return;
    }
    setRecord(result.value.record);
    setLifecycleKind(result.value.kind);
    setRecordThreadKey(key);
    if (!result.value.applied) {
      setReadError("This task changed while you were reopening it. Refresh and try again.");
      return;
    }
    setHidden(props.presentation === "recent");
    props.onReopen?.();
  };

  const settle = async () => {
    setBusy(true);
    setReadError(null);
    const result = await settleThread(threadRef);
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not settle task",
          description: failureDescription(result),
        }),
      );
      return;
    }
    if (result._tag === "Success") {
      const refreshed = await runLifecycle({
        environmentId,
        input: { threadId, action: "read" },
      });
      if (refreshed._tag === "Success") {
        setRecord(refreshed.value.record);
        setLifecycleKind(refreshed.value.kind);
        setRecordThreadKey(key);
      }
    } else if (result._tag === "Failure" && isAtomCommandInterrupted(result)) {
      return;
    }
  };

  if (kind !== "task" || (recordReady && lifecycleKind !== "task") || hidden) return null;
  const displayedSummary = currentRecord?.condition?.summary ?? "No completion condition";
  const displayedOutcome =
    [currentRecord?.outcome, settlementDescription(currentRecord)]
      .filter((value): value is string => Boolean(value))
      .join(" · ") || null;

  if (props.presentation === "recent") {
    return (
      <li className="flex min-h-8 items-center gap-1.5 px-1.5">
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(threadRef)}
          className="min-w-0 flex-1 truncate text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
        >
          {shell.title}
        </Link>
        <span className="max-w-32 shrink truncate text-3xs text-sidebar-muted-foreground/70">
          {recordReady ? (displayedOutcome ?? displayedSummary) : "Loading outcome…"}
        </span>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canOperate || busy}
          onClick={() => void reopen()}
        >
          <ArchiveRestoreIcon className="size-3" />
          Reopen
        </Button>
      </li>
    );
  }

  return (
    <>
      <ThreadDetailsSection headingId="thread-details-done-condition-heading" title="Done when">
        <div className="flex min-h-8 items-center gap-1 rounded-lg px-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
            {recordReady ? displayedSummary : "Loading done condition…"}
          </span>
          <ThreadDetailsControl
            part="meta"
            aria-label={currentRecord?.condition ? "Edit done condition" : "Set done condition"}
            disabled={!recordReady || !canOperate || busy}
            onClick={openEditor}
          >
            <PencilIcon className="size-3" />
            {currentRecord?.condition ? "Edit" : "Set"}
          </ThreadDetailsControl>
          {archived || settled ? (
            <ThreadDetailsControl
              part="meta"
              disabled={!recordReady || !canOperate || busy}
              onClick={() => void reopen()}
            >
              <ArchiveRestoreIcon className="size-3" />
              Reopen
            </ThreadDetailsControl>
          ) : supportsSettlement ? (
            <ThreadDetailsControl
              part="meta"
              disabled={!recordReady || !canOperate || busy}
              onClick={() => void settle()}
            >
              <CheckIcon className="size-3" />
              Settle
            </ThreadDetailsControl>
          ) : null}
        </div>
        {displayedOutcome ? (
          <p className="px-2.5 pb-1 text-xs text-muted-foreground">{displayedOutcome}</p>
        ) : null}
        {readError ? <p className="px-2.5 pb-1 text-xs text-destructive">{readError}</p> : null}
      </ThreadDetailsSection>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Done when</DialogTitle>
            <DialogDescription>
              Describe the result that should be true before this task is done. A folder agent
              checks it after the task’s work finishes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6">
            <label
              className="flex flex-col gap-1.5 text-sm font-medium"
              htmlFor="task-done-summary"
            >
              Done when
              <Input
                id="task-done-summary"
                value={summary}
                onChange={(event) => setSummary(event.currentTarget.value)}
                placeholder="The requested change is working"
                maxLength={240}
              />
            </label>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="task-done-input-group"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={`size-3.5 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
                />
                Advanced condition (optional)
              </button>
              <div
                id="task-done-input-group"
                hidden={!advancedOpen}
                className="flex flex-col gap-2"
              >
                <label
                  className="flex flex-col gap-1.5 text-sm font-medium"
                  htmlFor="task-done-input"
                >
                  Condition JSON
                  <Textarea
                    id="task-done-input"
                    value={inputText}
                    onChange={(event) => setInputText(event.currentTarget.value)}
                    placeholder={'{\n  "type": "event",\n  "on": "pr.merged"\n}'}
                    spellCheck={false}
                    aria-invalid={editorError !== undefined}
                    aria-describedby="task-done-input-help"
                  />
                </label>
                <p id="task-done-input-help" className="text-xs text-muted-foreground">
                  Optional JSON can wait for an event, date, or source, or combine conditions. It
                  takes precedence over the description above.
                </p>
                {editorError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {editorError}
                  </p>
                ) : null}
              </div>
              {!advancedOpen && editorError ? (
                <p role="alert" className="text-xs text-destructive">
                  Open the advanced condition to fix the JSON.
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canOperate || busy || !summary.trim() || editorError !== undefined}
              onClick={() => void saveCondition()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
