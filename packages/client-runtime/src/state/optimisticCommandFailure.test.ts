import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { ConnectionTransientError } from "../connection/model.ts";

import { isOptimisticCommandOutcomeUnknown } from "./optimisticCommandFailure.ts";

describe("optimistic command failures", () => {
  it.each([
    new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
    new ConnectionTransientError({ reason: "transport", detail: "Disconnected" }),
    new Cause.TimeoutError(),
  ])("keeps $_tag unconfirmed instead of rolling back a possibly committed edit", (error) => {
    expect(isOptimisticCommandOutcomeUnknown(Cause.fail(error))).toBe(true);
  });

  it.each([
    "OrchestrationDispatchCommandError",
    "EnvironmentAuthorizationError",
    "EnvironmentRpcUnavailableError",
    "EnvironmentNotRegisteredError",
  ])("allows rollback of a definitive %s refusal", (_tag) => {
    expect(isOptimisticCommandOutcomeUnknown(Cause.fail({ _tag }))).toBe(false);
  });

  it("does not treat a defect as proof the server refused the command", () => {
    expect(isOptimisticCommandOutcomeUnknown(Cause.die(new Error("Lost reply")))).toBe(true);
    expect(isOptimisticCommandOutcomeUnknown(Cause.fail(new Error("Access changed")))).toBe(false);
  });
});
