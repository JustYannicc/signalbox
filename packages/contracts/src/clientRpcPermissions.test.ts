import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  clientRpcRequiredScopes,
} from "./index.ts";

describe("task lifecycle client RPC permissions", () => {
  it("lets read actions use orchestration read scope", () => {
    expect(
      clientRpcRequiredScopes(AUTOMATION_WS_METHODS.automationsTaskLifecycle, {
        action: "read",
        threadId: "thread-1",
      }),
    ).toEqual([AuthOrchestrationReadScope]);
  });

  it.each(["propose", "complete", "reopen", "record-settle", undefined])(
    "requires orchestration operate scope for %s",
    (action) => {
      expect(
        clientRpcRequiredScopes(AUTOMATION_WS_METHODS.automationsTaskLifecycle, {
          ...(action === undefined ? {} : { action }),
          threadId: "thread-1",
        }),
      ).toEqual([AuthOrchestrationOperateScope]);
    },
  );
});
