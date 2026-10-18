import { describe, expect, it } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
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
