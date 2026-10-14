import { describe, expect, it } from "vite-plus/test";

import { needsPoolCopy, sendBlamesEnvironment } from "./needsPoolCopy";

const signIn = { _tag: "signIn", poolId: "work", instanceId: null } as const;
const noPool = { _tag: "noPool" } as const;
const connected = {
  environmentUnavailable: false,
  projectSelectionRequired: false,
  noProviderAvailable: true,
};

describe("needsPoolCopy", () => {
  it("points the placeholder at the pool to sign in to", () => {
    expect(needsPoolCopy(signIn, "Work").placeholder).toBe("Sign in to Work to send a message");
    expect(needsPoolCopy(signIn, undefined).action).toBe("Sign in to its pool");
  });

  it("asks for a pool when nothing above the folder has one", () => {
    expect(needsPoolCopy(noPool, undefined)).toMatchObject({
      action: "Choose a pool",
      placeholder: "Choose a pool to send a message",
    });
  });
});

describe("sendBlamesEnvironment", () => {
  it("leaves a connected environment out of a pool need", () => {
    expect(sendBlamesEnvironment({ ...connected, poolNeed: signIn })).toBe(false);
    expect(sendBlamesEnvironment({ ...connected, poolNeed: noPool })).toBe(false);
  });

  it("still blames a disconnected environment, pool need or not", () => {
    expect(
      sendBlamesEnvironment({ ...connected, environmentUnavailable: true, poolNeed: signIn }),
    ).toBe(true);
  });

  it("keeps upstream's no-provider behavior where pools don't apply", () => {
    expect(sendBlamesEnvironment({ ...connected, poolNeed: null })).toBe(true);
    expect(
      sendBlamesEnvironment({ ...connected, noProviderAvailable: false, poolNeed: null }),
    ).toBe(false);
  });
});
