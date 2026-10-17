import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing" | "error";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  draftThreadExists: boolean;
  detailStatus?: EnvironmentThreadStatus;
  detailExists?: boolean;
  detailDeleted?: boolean;
  detailError?: string | null;
}): ThreadRouteRenderState {
  if (input.draftThreadExists) {
    return "ready";
  }
  if (input.serverThreadExists) {
    if (!input.serverThreadDeleted) {
      return "ready";
    }
    return input.bootstrapComplete ? "missing" : "loading";
  }
  if (input.detailStatus === "deleted") {
    return "missing";
  }
  if (input.detailStatus === "live" && input.detailExists === true) {
    return input.detailDeleted === true ? "missing" : "ready";
  }
  if (input.detailError?.trim()) {
    return "error";
  }
  return "loading";
}

export function resolveThreadRouteDetailRef(
  target: ThreadRouteTarget | null,
  input: { serverThreadExists: boolean; pendingDraftThreadExists: boolean },
): ScopedThreadRef | null {
  if (target?.kind !== "server" || input.serverThreadExists || input.pendingDraftThreadExists) {
    return null;
  }
  return target.threadRef;
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
