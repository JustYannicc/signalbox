import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "@t3tools/contracts/signalboxPersonBrowser";
import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";

describe("cloud browser profile permissions", () => {
  it("requires preview control permission to clear saved sign-ins", () => {
    expect(clientRpcRequiredScopes(SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile, {})).toEqual([
      AuthPreviewOperateScope,
    ]);
  });

  it("requires orchestration permission to start a folder from existing work", () => {
    expect(clientRpcRequiredScopes(SIGNALBOX_FOLDERS_WS_METHODS.startFrom, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });
});

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
