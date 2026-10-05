import { assert, describe, it } from "@effect/vitest";

import { applySignalboxEnvironment } from "./signalboxEnvironment.ts";

describe("applySignalboxEnvironment", () => {
  it("uses Signalbox settings instead of inherited T3 Code settings", () => {
    const environment = {
      SIGNALBOX_HOME: "/home/user/.signalbox-test",
      SIGNALBOX_PORT: "13773",
      T3CODE_HOME: "/home/user/.t3",
      T3CODE_PORT: "13774",
    };

    applySignalboxEnvironment(environment);

    assert.equal(environment.T3CODE_HOME, "/home/user/.signalbox-test");
    assert.equal(environment.T3CODE_PORT, "13773");
    assert.equal(environment.SIGNALBOX_HOME, "/home/user/.signalbox-test");
    assert.isUndefined(environment.SIGNALBOX_PORT);
  });

  it("removes ambient T3 Code settings when Signalbox settings are unset", () => {
    const environment = {
      T3CODE_HOME: "/home/user/.t3",
      T3CODE_PORT: "13774",
    };

    applySignalboxEnvironment(environment);

    assert.isUndefined(environment.T3CODE_HOME);
    assert.isUndefined(environment.T3CODE_PORT);
  });

  it("preserves homes written by Signalbox-managed services", () => {
    for (const serviceUnit of ["signalbox.service", "com.justyannicc.signalbox.service.plist"]) {
      const environment = {
        T3_BOOT_SERVICE_UNIT: serviceUnit,
        T3CODE_HOME: "/home/user/.signalbox-service",
        T3CODE_PORT: "13774",
      };

      applySignalboxEnvironment(environment);

      assert.equal(environment.T3CODE_HOME, "/home/user/.signalbox-service");
      assert.isUndefined(environment.T3CODE_PORT);
    }
  });

  it("ignores a T3 Code service home", () => {
    const environment = {
      T3_BOOT_SERVICE_UNIT: "t3.service",
      T3CODE_HOME: "/home/user/.t3",
      T3CODE_PORT: "13774",
    };

    applySignalboxEnvironment(environment);

    assert.isUndefined(environment.T3CODE_HOME);
    assert.isUndefined(environment.T3CODE_PORT);
  });
});
