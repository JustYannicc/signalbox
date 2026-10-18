import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CLOUD_CLIENT_SCOPES } from "./CloudScopes.ts";

describe("cloud client scopes", () => {
  it("keep access and relay management out of every cloud credential", () => {
    expect(CLOUD_CLIENT_SCOPES).not.toContain(AuthAccessReadScope);
    expect(CLOUD_CLIENT_SCOPES).not.toContain(AuthAccessWriteScope);
    expect(CLOUD_CLIENT_SCOPES).not.toContain(AuthRelayWriteScope);
    expect(CLOUD_CLIENT_SCOPES.length).toBe(AuthStandardClientScopes.length - 3);
  });
});
