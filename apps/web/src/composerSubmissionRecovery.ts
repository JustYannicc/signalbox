import {
  isTransportConnectionErrorMessage,
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "./composerDraftStore";

/** A lost response cannot tell us whether the server accepted the message. */
export function isComposerSubmissionUncertain(
  result: AtomCommandResult<unknown, unknown>,
  requestStarted: boolean,
): boolean {
  if (result._tag !== "Failure" || !requestStarted) return false;
  if (isAtomCommandInterrupted(result)) return true;
  const error = squashAtomCommandFailure(result);
  if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error)) return false;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
      case "ConnectionTransientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return false;
      case "RpcClientError":
      case "OrchestrationV2ThreadLaunchError":
        return true;
    }
  }
  return isTransportConnectionErrorMessage(error instanceof Error ? error.message : String(error));
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function recoverComposerSubmission(input: {
  target: ComposerThreadTarget;
  result: AtomCommandResult<unknown, unknown>;
  requestStarted: boolean;
  content: Pick<
    ComposerThreadDraftState,
    | "prompt"
    | "images"
    | "files"
    | "terminalContexts"
    | "previewAnnotations"
    | "reviewComments"
    | "threadContexts"
  >;
}) {
  if (isComposerSubmissionUncertain(input.result, input.requestStarted)) return "uncertain";
  const store = useComposerDraftStore.getState();
  if (composerDraftHasUserContent(store.getComposerDraft(input.target))) return "occupied";
  const { target, content } = input;
  store.setPrompt(target, content.prompt);
  store.addImages(target, content.images.map(cloneComposerImageForRetry));
  store.addFiles(target, content.files);
  store.setTerminalContexts(target, content.terminalContexts);
  store.setPreviewAnnotations(target, content.previewAnnotations);
  store.setReviewComments(target, content.reviewComments);
  store.setThreadContexts(target, content.threadContexts);
  return "restored";
}
