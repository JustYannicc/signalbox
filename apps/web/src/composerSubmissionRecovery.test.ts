import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { isComposerSubmissionUncertain } from "./composerSubmissionRecovery";

describe("composer submission recovery", () => {
  it("does not restore an interrupted request that may have reached the server", () => {
    const result = AsyncResult.failure(Cause.interrupt(1));
    expect(isComposerSubmissionUncertain(result, true)).toBe(true);
    expect(isComposerSubmissionUncertain(result, false)).toBe(false);
  });

  it.each([
    { _tag: "RpcClientError", message: "SocketCloseError" },
    { _tag: "ConnectionTransientError", message: "Connection lost" },
    { _tag: "EnvironmentRpcUnavailableError" },
    new Error("Socket is not connected"),
  ])("keeps a possibly accepted prompt out of the draft after %o", (error) => {
    const result = AsyncResult.failure(Cause.fail(error));
    expect(isComposerSubmissionUncertain(result, true)).toBe(true);
    expect(isComposerSubmissionUncertain(result, false)).toBe(false);
  });

  it.each([
    { _tag: "OrchestrationDispatchCommandError", message: "Thread is not connected." },
    { _tag: "EnvironmentAuthorizationError", message: "Permission denied" },
    new Error("Model is not supported"),
  ])("allows restoring a rejected prompt after %o", (error) => {
    expect(isComposerSubmissionUncertain(AsyncResult.failure(Cause.fail(error)), true)).toBe(false);
  });
});
