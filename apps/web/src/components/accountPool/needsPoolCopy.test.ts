import { describe, expect, it } from "vite-plus/test";

import { needsPoolCopy, sendBlamesEnvironment } from "./needsPoolCopy";

const signIn = { _tag: "signIn", poolId: "work", instanceId: null } as const;
const noPool = { _tag: "noPool" } as const;
const noModels = {
  _tag: "noModels",
  poolId: "work",
  message: "This pool's accounts serve no models right now. Try again shortly.",
} as const;
const unavailable = {
  _tag: "unavailable",
  poolId: "work",
  message: "The pool is unavailable right now. Try again.",
} as const;
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

  it("points a signed-in pool with no models to pool settings", () => {
    expect(needsPoolCopy(noModels, "Work")).toMatchObject({
      action: "Open pool settings",
      why: noModels.message,
      placeholder: "No models are available from this pool right now.",
    });
  });

  it("shows the pool error instead of asking the user to sign in", () => {
    expect(needsPoolCopy(unavailable, "Work")).toMatchObject({
      action: "Open pool settings",
      why: unavailable.message,
      placeholder: "This pool is unavailable right now.",
    });
  });
});

describe("sendBlamesEnvironment", () => {
  it("leaves a connected environment out of a pool need", () => {
    expect(sendBlamesEnvironment({ ...connected, poolNeeded: true })).toBe(false);
  });

  it("still blames a disconnected environment, pool need or not", () => {
    expect(
      sendBlamesEnvironment({ ...connected, environmentUnavailable: true, poolNeeded: true }),
    ).toBe(true);
  });

  it("keeps upstream's no-provider behavior where pools don't apply", () => {
    expect(sendBlamesEnvironment({ ...connected, poolNeeded: false })).toBe(true);
    expect(
      sendBlamesEnvironment({ ...connected, noProviderAvailable: false, poolNeeded: false }),
    ).toBe(false);
  });
});
