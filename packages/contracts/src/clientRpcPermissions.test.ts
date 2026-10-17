import { describe, expect, it } from "vite-plus/test";

import { AuthPreviewOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "./signalboxPersonBrowser.ts";

describe("cloud browser profile permissions", () => {
  it("requires preview control permission to clear saved sign-ins", () => {
    expect(clientRpcRequiredScopes(SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile, {})).toEqual([
      AuthPreviewOperateScope,
    ]);
  });
});
