import { describe, expect, it } from "vite-plus/test";

import { AuthPreviewOperateScope, clientRpcRequiredScopes } from "@t3tools/contracts";
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "@t3tools/contracts/signalboxPersonBrowser";

describe("cloud browser profile permissions", () => {
  it("requires preview control permission to clear saved sign-ins", () => {
    expect(clientRpcRequiredScopes(SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile, {})).toEqual([
      AuthPreviewOperateScope,
    ]);
  });
});
