import { describe, expect, it } from "vite-plus/test";
import {
  ChildWorkerDispatchError,
  isStoppedWorkerLoaderQuotaFailure,
  WORKER_LOADER_QUOTA_MESSAGES,
} from "../ChildWorkerDispatchError.ts";

describe("confirmed Worker Loader quota failures", () => {
  it.each(WORKER_LOADER_QUOTA_MESSAGES)(
    "recognizes an acknowledged runtime failure: %s",
    (message) => {
      const cause = Object.assign(new Error(message), { code: "EAGAIN" });
      expect(
        isStoppedWorkerLoaderQuotaFailure(new ChildWorkerDispatchError(cause, { kind: "stopped" })),
      ).toBe(true);
    },
  );

  it("keeps uncertain stops and error lookalikes on the ordinary failure path", () => {
    const message = WORKER_LOADER_QUOTA_MESSAGES[0]!;
    const cause = Object.assign(new Error(message), { code: "EAGAIN" });
    const uncertain = new ChildWorkerDispatchError(cause, {
      kind: "unconfirmed",
      stopped: Promise.resolve(),
    });
    const failures = [
      uncertain,
      cause,
      { code: "CHILD_EXECUTION_FAILED", termination: { kind: "stopped" }, cause },
      new ChildWorkerDispatchError({ name: "Error", message, code: "EAGAIN" }, { kind: "stopped" }),
      new ChildWorkerDispatchError(new Error(message), { kind: "stopped" }),
      new ChildWorkerDispatchError(Object.assign(new Error("Guest failure"), { code: "EAGAIN" }), {
        kind: "stopped",
      }),
    ];
    for (const failure of failures) expect(isStoppedWorkerLoaderQuotaFailure(failure)).toBe(false);
  });
});
