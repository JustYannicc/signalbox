import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import ChatView from "./ChatView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { useAtomCommand } from "../state/use-atom-command";
import { SidebarInset } from "./ui/sidebar";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  useEnvironmentThreadRefs,
  useThreadProjection,
  useThreadRefs,
  useThreadError,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteDetailRef,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Plain server threads are unkeyed, so navigating between them reuses one instance as ChatView
 * expects. Rendered by the `_chat` layout rather than by the two leaf routes, since an element
 * only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef);
  const serverThreadShell = useThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread: serverThreadShell,
          backgroundSubmissionPending,
        })
      : null;

  const shell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shell.data?.status);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const routeDetailRef = resolveThreadRouteDetailRef(target, {
    serverThreadExists: serverThreadShell !== null,
    pendingDraftThreadExists: draftThread !== null,
  });
  const routeThreadProjection = useThreadProjection(routeDetailRef);
  const routeThreadDetailStatus = useThreadStatus(routeDetailRef);
  const routeThreadDetailError = useThreadError(routeDetailRef);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const [retryingThreadKey, setRetryingThreadKey] = useState<string | null>(null);
  const [retryCommandError, setRetryCommandError] = useState<{
    readonly threadKey: string;
    readonly message: string;
  } | null>(null);
  const routeThreadKey = routeDetailRef === null ? null : scopedThreadKey(routeDetailRef);
  const retrying = retryingThreadKey !== null;
  const retryErrorMessage =
    retryCommandError?.threadKey === routeThreadKey ? retryCommandError.message : null;
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    draftThreadExists: draftThread !== null,
    ...(routeDetailRef === null
      ? {}
      : {
          detailStatus: routeThreadDetailStatus,
          detailExists: routeThreadProjection !== null,
          detailDeleted: routeThreadProjection?.projection.thread.deletedAt != null,
          detailError: routeThreadDetailError ?? retryErrorMessage,
        }),
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server") {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [environmentHasAnyThreads, navigate, renderState, target]);

  const retryRouteThread = () => {
    if (routeDetailRef === null || routeThreadKey === null || retryingThreadKey !== null) {
      return;
    }
    const threadKey = routeThreadKey;
    setRetryingThreadKey(threadKey);
    setRetryCommandError(null);
    void retryEnvironment(routeDetailRef.environmentId).then(
      (result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setRetryCommandError({
            threadKey,
            message: error instanceof Error ? error.message : "Could not reconnect. Try again.",
          });
        }
        setRetryingThreadKey((current) => (current === threadKey ? null : current));
      },
      () => setRetryingThreadKey((current) => (current === threadKey ? null : current)),
    );
  };

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (renderState === "error") {
    view = (
      <div className="flex h-full w-full items-center justify-center px-4">
        <Alert className="w-full max-w-lg" controlAlignment="first-line" variant="error">
          <AlertTitle>Could not load this thread</AlertTitle>
          <AlertDescription className="break-words">
            {retryErrorMessage ?? routeThreadDetailError ?? "Check the connection and try again."}
          </AlertDescription>
          <AlertAction>
            <Button disabled={retrying} onClick={retryRouteThread} size="sm" variant="outline">
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextChatViewKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {view}
    </SidebarInset>
  );
}
