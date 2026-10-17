import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import { isOptimisticCommandOutcomeUnknown } from "./optimisticCommandFailure.ts";

describe("optimistic command failures", () => {
  it.each([
    "RpcClientError",
    "ConnectionTransientError",
    "EnvironmentRpcUnavailableError",
    "EnvironmentNotRegisteredError",
    "TimeoutError",
  ])("keeps %s unconfirmed instead of rolling back a possibly committed edit", (_tag) => {
    expect(isOptimisticCommandOutcomeUnknown(Cause.fail({ _tag }))).toBe(true);
  });

  it.each(["OrchestrationDispatchCommandError", "EnvironmentAuthorizationError"])(
    "allows rollback of a definitive %s refusal",
    (_tag) => {
      expect(isOptimisticCommandOutcomeUnknown(Cause.fail({ _tag }))).toBe(false);
    },
  );

  it("does not treat a defect as proof the server refused the command", () => {
    expect(isOptimisticCommandOutcomeUnknown(Cause.die(new Error("Lost reply")))).toBe(true);
    expect(isOptimisticCommandOutcomeUnknown(Cause.fail(new Error("Access changed")))).toBe(false);
  });
});
