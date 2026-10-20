import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessRequestSupervisor,
  type HarnessRequestSupervisorOptions,
} from "../../HarnessRequestSupervisor.ts";

const options = () => {
  let accesses = 0;
  const input: HarnessRequestSupervisorOptions = {
    facets: {
      get: () => {
        accesses += 1;
        throw new Error("Unexpected facet access");
      },
      abort: () => {
        accesses += 1;
      },
      delete: () => {
        accesses += 1;
      },
    },
    loader: {
      get: () => {
        accesses += 1;
        throw new Error("Unexpected loader access");
      },
    },
    name: "facet",
    applicationKey: "application",
    entrypoint: "Harness",
    code: {
      compatibilityDate: "2026-10-19",
      mainModule: "main.js",
      modules: { "main.js": "export default {};" },
    },
  };
  return { input, accesses: () => accesses };
};

describe("HarnessRequestSupervisor", () => {
  it.each([0, -1, 300001, 1.5, NaN, Infinity])(
    "refuses unsupported CPU allowance %s before any platform access",
    (cpuMs) => {
      const fixture = options();
      expect(() => createHarnessRequestSupervisor({ ...fixture.input, cpuMs })).toThrow();
      expect(fixture.accesses()).toBe(0);
    },
  );

  it("refuses a conflicting worker allowance before creating a facet application", () => {
    const fixture = options();
    expect(() =>
      createHarnessRequestSupervisor({
        ...fixture.input,
        cpuMs: 1000,
        code: { ...fixture.input.code, limits: { cpuMs: 2000 } },
      }),
    ).toThrow();
    expect(fixture.accesses()).toBe(0);
  });

  it.each(["name", "applicationKey", "entrypoint"] as const)(
    "refuses a missing %s without loading or aborting another facet",
    (key) => {
      const fixture = options();
      expect(() => createHarnessRequestSupervisor({ ...fixture.input, [key]: "" })).toThrow();
      expect(fixture.accesses()).toBe(0);
    },
  );

  it("requires an own main-module entry instead of inheriting Object.prototype", () => {
    const fixture = options();
    expect(() =>
      createHarnessRequestSupervisor({
        ...fixture.input,
        code: { ...fixture.input.code, mainModule: "toString", modules: {} },
      }),
    ).toThrow();
    expect(fixture.accesses()).toBe(0);
  });
});
