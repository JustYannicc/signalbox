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

export function cloneComposerImageForRetry<Image extends { previewUrl: string; file: Blob }>(
  image: Image,
): Image {
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
