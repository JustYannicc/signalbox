import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pullRequestThreadPreparationOperationId,
  resolvePreparedPullRequestThread,
} from "@t3tools/client-runtime/state/pull-request-thread-preparation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { useNavigate } from "@tanstack/react-router";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import type { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import type { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { readThreadShell, waitForThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { toastManager } from "../ui/toast";

interface OpenedDraft {
  readonly draftId: DraftId;
  readonly threadId: ThreadId;
}

/**
 * The draft each unanswered preparation was asked for, until the environment answers. A failure
 * can mean the cloud made the thread and only the reply was lost; the shell then adopts the
 * draft, so the project's next draft is a different one, and asking again under it would make a
 * second thread. A retry asks again for the same thread under the same operation id instead, and
 * concurrent callers share the one open. Memory only: a reload starts over, like any draft does.
 */
const unansweredPreparations = new Map<string, Promise<OpenedDraft | null>>();

function preparationKey(input: {
  readonly projectRef: ScopedProjectRef;
  readonly reference: string;
  readonly mode: string;
}): string {
  return JSON.stringify([
    input.projectRef.environmentId,
    input.projectRef.projectId,
    input.mode,
    input.reference,
  ]);
}

/**
 * An unanswered preparation stops being worth repeating once its draft is gone without a thread,
 * or its thread has had a turn: the environment refuses a used thread, so repeating would pin
 * every later attempt to that refusal.
 */
function stillRepeatable(projectRef: ScopedProjectRef, opened: OpenedDraft): boolean {
  const shell = readThreadShell(scopeThreadRef(projectRef.environmentId, opened.threadId));
  if (shell === null) {
    return useComposerDraftStore.getState().getDraftSession(opened.draftId) !== null;
  }
  return shell.latestRun === null && shell.latestUserMessageAt === null;
}

export interface PullRequestThreadTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

/**
 * Copy for an environment whose checkout lives on a machine the user reaches (`localFilesystem`)
 * versus one that keeps the pull request's code inside the thread, where a checkout, a worktree
 * or a setup script would describe machinery nobody sees.
 */
const HOST_CHECKOUT_COPY = {
  preparing: "Preparing the pull request checkout...",
  openFailed: "Could not open a thread for the checkout",
  prepareFailed: "Could not prepare the pull request checkout",
} as const;

const THREAD_COPY = {
  preparing: "Starting a thread on the pull request...",
  openFailed: "Could not open a thread",
  prepareFailed: "Could not start a thread on this pull request",
} as const;

const TASK_IN_COMPOSER = "The task is in the composer — read it over, then send.";

/**
 * One explicit preparation of a pull request for work: open (or reuse) the project's draft, ask
 * the environment to prepare the pull request for that draft's thread, then put the task in front
 * of the reader. Questions never come through here; they only open a draft.
 */
export async function runPullRequestThreadHandoff(input: {
  readonly projectRef: ScopedProjectRef;
  readonly reference: string;
  readonly mode: "worktree" | "local";
  readonly task: PullRequestThreadTask | null;
  /** The environment's filesystem is a machine the user reaches (`localFilesystem`). */
  readonly hostCheckout: boolean;
  readonly newThread: ReturnType<typeof useNewThreadHandler>;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly prepare: ReturnType<typeof usePreparePullRequestThreadAction>["run"];
  readonly writeTask: (draftId: DraftId, task: PullRequestThreadTask) => void;
}): Promise<void> {
  const { projectRef, reference, mode, task, newThread } = input;
  const copy = input.hostCheckout ? HOST_CHECKOUT_COPY : THREAD_COPY;
  // It carries no timeout of its own: a loading toast never expires, and an explicit one
  // would survive the update and pin the result on screen.
  const toastId = toastManager.add({ type: "loading", title: copy.preparing });
  // The draft comes first: its thread id is what the environment prepares, so a self-hosted
  // setup script knows which thread the checkout is for, and the cloud makes that very thread.
  const key = preparationKey(input);
  const unanswered = unansweredPreparations.get(key) ?? null;
  const repeated = unanswered === null ? null : await unanswered;
  const repeating = repeated !== null && stillRepeatable(projectRef, repeated);
  const opening =
    repeating && unanswered !== null
      ? unanswered
      : newThread(projectRef).then(
          (session) => session,
          () => null,
        );
  unansweredPreparations.set(key, opening);
  const forget = () => {
    if (unansweredPreparations.get(key) === opening) unansweredPreparations.delete(key);
  };
  const opened = await opening;
  if (repeating && opened !== null) {
    // The first attempt opened this draft; bring the reader back to it, or to the thread the
    // environment already made from it, without asking for another draft.
    const threadRef = scopeThreadRef(projectRef.environmentId, opened.threadId);
    await (readThreadShell(threadRef) !== null
      ? input.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        })
      : input.navigate({ to: "/draft/$draftId", params: { draftId: opened.draftId } }));
  }
  if (opened === null) {
    forget();
    toastManager.update(toastId, {
      type: "error",
      title: copy.openFailed,
      description: "Try again from the project, or open a thread first.",
    });
    return;
  }
  // A retry repeats the same request under the same id, so the environment answers from its
  // receipt instead of preparing twice.
  const prepared = await input.prepare({
    reference,
    mode,
    threadId: opened.threadId,
    operationId: pullRequestThreadPreparationOperationId({
      threadId: opened.threadId,
      reference,
      mode,
    }),
  });
  if (prepared._tag === "Failure") {
    const error = squashAtomCommandFailure(prepared);
    toastManager.update(toastId, {
      type: "error",
      title: copy.prepareFailed,
      ...(error instanceof Error && error.message.length > 0 ? { description: error.message } : {}),
    });
    return;
  }
  forget();
  const outcome = resolvePreparedPullRequestThread(opened.threadId, prepared.value);

  if (outcome.kind === "mismatch") {
    toastManager.update(toastId, {
      type: "error",
      title: copy.prepareFailed,
      description: "It came back for a different thread, so nothing was opened. Try again.",
    });
    return;
  }

  if (outcome.kind === "server-thread") {
    // The draft already carries this thread id, so it adopts the thread once its shell arrives
    // and keeps everything typed into it. Sending before then would try to create the thread a
    // second time, so the task only lands once the thread is known.
    const loaded = await waitForThreadShell(
      scopeThreadRef(projectRef.environmentId, outcome.threadId),
    );
    if (task !== null) input.writeTask(opened.draftId, task);
    toastManager.update(
      toastId,
      loaded
        ? {
            type: "success",
            title: "Thread ready",
            description:
              task === null
                ? "It's on the pull request's latest commit. Nothing runs until you send."
                : TASK_IN_COMPOSER,
          }
        : {
            type: "warning",
            title: "Thread created, still loading",
            description: "Give it a moment, then send.",
          },
    );
    return;
  }

  const pointed = await newThread(projectRef, {
    branch: outcome.branch,
    worktreePath: outcome.worktreePath,
    envMode: outcome.worktreePath === null ? "local" : "worktree",
  }).then(
    (session) => session !== null,
    () => false,
  );
  if (!pointed) {
    // The checkout is on disk; only the thread failed to move onto it. Writing the task now
    // would send the agent at whatever the thread was already open on — which is the one
    // outcome worth stopping for, since it reads as success and is not.
    toastManager.update(toastId, {
      type: "error",
      title: "Checked out, but the thread stayed where it was",
      description: `The checkout is ready on \`${outcome.branch}\`. Point a thread at it from the branch picker, then ask again.`,
    });
    return;
  }
  if (task !== null) input.writeTask(opened.draftId, task);
  toastManager.update(
    toastId,
    !outcome.isOnPullRequestHead
      ? {
          type: "warning",
          title: "Checked out, but not on the latest commits",
          description:
            "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
        }
      : task !== null
        ? { type: "success", title: "Checkout ready", description: TASK_IN_COMPOSER }
        : {
            type: "success",
            title: mode === "local" ? "Checked out here" : "Checked out",
            description:
              mode === "local"
                ? "This repository is on the pull request's branch, with a thread open on it."
                : "The pull request is in its own worktree, with a thread open on it.",
          },
  );
}
