import { useAtomValue } from "@effect/atom-react";
import { mergeAgentBrowserSteps } from "@t3tools/client-runtime/state/signalboxAgentBrowser";
import {
  agentBrowserFrame,
  agentBrowserMirrorContent,
  agentBrowserPlaceLabel,
  agentBrowserStatus,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import { createAgentBrowserInputSender } from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentBrowserInput, AgentBrowserTab } from "@t3tools/contracts/signalboxPreviews";
import { GlobeIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openOwnCopy } from "~/browsing/openOwnCopy";
import { cn } from "~/lib/utils";
import { useEnvironmentSupportsThreadBrowsing } from "~/state/browsing";
import { signalboxAgentBrowser, useAgentBrowserTrail } from "~/state/signalboxAgentBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { AgentBrowserMirrorFrame } from "./AgentBrowserMirrorFrame";
import { AgentBrowserTrail } from "./AgentBrowserTrail";
import { useAgentBrowserLease } from "./useAgentBrowserLease";

const tabLabel = (tab: AgentBrowserTab) => agentBrowserPlaceLabel(tab.title, tab.url, "New tab");

const CONTROL_DOT = {
  agent: "bg-muted-foreground/60",
  you: "bg-primary",
  "someone-else": "bg-warning",
} as const;

/**
 * The agent's browser in the right panel: its tabs mirrored live, who drives,
 * take over and hand back, and the trail of steps. Watches only while the
 * panel shows and the person is around.
 */
export function AgentBrowserPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly visible: boolean;
}) {
  const { environmentId, threadId } = props;
  const trail = useAgentBrowserTrail(environmentId, threadId);
  const { watching, noteActivity } = useAgentBrowserLease(props.visible && trail.supported);
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const canDrive = useAtomValue(signalboxAgentBrowser.input.permissionAtom(environmentId));
  const canCopy = useEnvironmentSupportsThreadBrowsing(environmentId);
  const onCopy = useCallback(
    (url: string) => void openOwnCopy({ environmentId, threadId }, url),
    [environmentId, threadId],
  );
  const sendInput = useAtomCommand(signalboxAgentBrowser.input, { reportFailure: false });

  const watch = useEnvironmentQuery(
    watching
      ? signalboxAgentBrowser.watch({ environmentId, input: { threadId, tabId: pinnedTabId } })
      : null,
  );
  const view = watch.data;
  // A watch that failed (the cloud cuts a view that fell behind) opens again
  // once the person is around, not in a loop on its own.
  const { error: watchError, refresh: refreshWatch } = watch;
  const onActivity = useCallback(() => {
    noteActivity();
    if (watchError !== null) refreshWatch();
  }, [noteActivity, refreshWatch, watchError]);
  useEffect(() => {
    if (watchError === null || !watching) return;
    const reopen = () => refreshWatch();
    document.addEventListener("pointerdown", reopen, { capture: true, once: true });
    document.addEventListener("keydown", reopen, { capture: true, once: true });
    return () => {
      document.removeEventListener("pointerdown", reopen, { capture: true });
      document.removeEventListener("keydown", reopen, { capture: true });
    };
  }, [refreshWatch, watchError, watching]);

  // A pinned tab the agent closed: follow the agent again.
  if (
    pinnedTabId !== null &&
    view !== null &&
    !view.offline &&
    !view.tabs.some((tab) => tab.tabId === pinnedTabId)
  ) {
    setPinnedTabId(null);
  }

  const steps = useMemo(
    () => mergeAgentBrowserSteps(trail.steps, view?.steps ?? []),
    [trail.steps, view?.steps],
  );
  // Steps that landed while watching live only in the stream, which pausing
  // drops; read the stored trail once then, and only if it lacks some.
  const unstored = steps.length > (trail.steps?.length ?? 0);
  const unstoredWhileWatchingRef = useRef(false);
  const { refresh: refreshTrail } = trail;
  useEffect(() => {
    if (watching) {
      unstoredWhileWatchingRef.current = unstored;
    } else if (unstoredWhileWatchingRef.current) {
      unstoredWhileWatchingRef.current = false;
      refreshTrail();
    }
  }, [refreshTrail, unstored, watching]);
  const lastStepId = steps.at(-1)?.stepId ?? null;
  const frame = agentBrowserFrame({ view, selectedStepId, lastStepId });
  const recording = useEnvironmentQuery(
    frame.kind === "step"
      ? signalboxAgentBrowser.step({ environmentId, input: { threadId, stepId: frame.stepId } })
      : null,
  );
  const content = agentBrowserMirrorContent(frame, recording.data);

  const live = view !== null && !view.offline && view.tabId !== null;
  const viewerId = view?.viewerId ?? null;
  const driving = live && view.control === "you";
  const interactive = driving && watching && selectedStepId === null;

  const send = useCallback(
    (input: AgentBrowserInput) => {
      if (viewerId === null) return Promise.resolve(null);
      return sendInput({ environmentId, input: { threadId, viewerId, input } });
    },
    [environmentId, sendInput, threadId, viewerId],
  );
  const onInput = useMemo(() => createAgentBrowserInputSender(send), [send]);
  const changeControl = (input: AgentBrowserInput) => {
    void send(input).then((result) => {
      if (result === null || isAtomCommandInterrupted(result) || result._tag === "Success") return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: input._tag === "take" ? "Couldn't take over" : "Couldn't hand back",
        description:
          error instanceof Error && error.message.trim().length > 0 ? error.message : "Try again.",
      });
    });
  };

  const status = agentBrowserStatus({
    view,
    watching,
    error: watch.error,
    hasSteps: lastStepId !== null,
  });
  const selectedIndex =
    selectedStepId === null ? -1 : steps.findIndex((step) => step.stepId === selectedStepId);
  const shownStepId = frame.kind === "step" ? frame.stepId : null;

  if (!trail.supported) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Agent's browser</EmptyTitle>
          <EmptyDescription>
            Follow the agent's browser in threads that run in Signalbox Cloud.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {live && view.tabs.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
          {view.tabs.map((tab) => (
            <Tooltip key={tab.tabId}>
              <TooltipTrigger
                render={
                  <Button
                    variant={tab.tabId === view.tabId ? "secondary" : "ghost-muted"}
                    size="xs"
                    aria-pressed={tab.tabId === view.tabId}
                    onClick={() => setPinnedTabId(tab.tabId)}
                  />
                }
              >
                {tab.browser === "person" ? <GlobeIcon aria-hidden /> : <ServerIcon aria-hidden />}
                <span className="max-w-40 truncate">{tabLabel(tab)}</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {tab.browser === "person" ? "Your cloud browser" : "The machine's browser"} ·{" "}
                {tab.url}
              </TooltipPopup>
            </Tooltip>
          ))}
          {pinnedTabId !== null ? (
            <Button variant="ghost-muted" size="xs" onClick={() => setPinnedTabId(null)}>
              Follow the agent
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <p role="status" className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          {selectedIndex >= 0 ? (
            <span className="truncate text-foreground">
              Step {selectedIndex + 1} of {steps.length}
            </span>
          ) : (
            <>
              {status.control !== null && view !== null ? (
                <>
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", CONTROL_DOT[view.control])}
                  />
                  <span className="shrink-0 text-foreground">{status.control}</span>
                </>
              ) : null}
              {status.detail !== null ? (
                <span className="truncate text-muted-foreground">
                  {status.control !== null ? "· " : null}
                  {status.detail}
                </span>
              ) : null}
            </>
          )}
        </p>
        {selectedStepId !== null ? (
          <Button variant="outline" size="xs" onClick={() => setSelectedStepId(null)}>
            Live
          </Button>
        ) : live && canDrive ? (
          driving ? (
            <Button variant="default" size="xs" onClick={() => changeControl({ _tag: "release" })}>
              Hand back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={view.control === "someone-else"}
              onClick={() => changeControl({ _tag: "take" })}
            >
              Take over
            </Button>
          )
        ) : null}
      </div>

      {/* Kernel's refusal shows even when it kept the agent from opening any tab. */}
      {view !== null && !view.offline && view.problem !== null ? (
        <div className="shrink-0 border-b p-2">
          <Alert variant="warning">
            <TriangleAlertIcon aria-hidden />
            <AlertDescription>{view.problem}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-muted/40">
        <AgentBrowserMirrorFrame
          content={content}
          interactive={interactive}
          onInput={onInput}
          onActivity={onActivity}
          {...(canCopy ? { onCopy } : {})}
        />
        {frame.kind === "blank" || (frame.kind === "step" && recording.error !== null) ? (
          <div className="absolute inset-0 flex bg-background">
            <Empty>
              <EmptyHeader>
                <EmptyDescription>
                  {frame.kind === "blank" ? frame.reason : recording.error}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : null}
      </div>

      {steps.length > 0 ? (
        <AgentBrowserTrail steps={steps} shownStepId={shownStepId} onSelect={setSelectedStepId} />
      ) : null}
    </div>
  );
}
