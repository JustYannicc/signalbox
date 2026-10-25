import { describe, expect, it } from "@effect/vitest";
import { getNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";
import {
  classifyNodeNativeBuiltinCapability,
  type NodeNativeBuiltinRequest,
  type NodeNativeRuntimeProfile,
} from "../NodeNativeBuiltinCapabilities.ts";

const auditedProfile: NodeNativeRuntimeProfile = {
  runtime: "workerd",
  workerdVersion: "1.20261012.1",
  nodeCompatibilityRevision: "workerd-nodejs-compat@1.20261012.1",
  compatibilityDate: "2026-10-01",
  compatibilityFlags: ["legacy_module_registry", "nodejs_compat"],
};

function classifyNative(
  modules: Readonly<Record<string, object>>,
  request: NodeNativeBuiltinRequest,
  auditedDefaultModules: Readonly<Record<string, object>> = modules,
) {
  return classifyNodeNativeBuiltinCapability({
    modules,
    auditedDefaultModules,
    request,
    runtimeProfile: auditedProfile,
  });
}

describe("native Node builtin evidence", () => {
  it("requires the exact observed Workerd and Node compatibility profile", () => {
    const crypto = { createHash: () => "native" };
    const modules = { crypto };
    const request = { specifier: "node:crypto", memberPath: ["createHash"] };

    expect(
      classifyNodeNativeBuiltinCapability({ modules, auditedDefaultModules: modules, request }),
    ).toBeUndefined();

    const mismatches: readonly NodeNativeRuntimeProfile[] = [
      { ...auditedProfile, runtime: "node" },
      { ...auditedProfile, workerdVersion: "1.20260101.1" },
      { ...auditedProfile, nodeCompatibilityRevision: "node-v24.0.0" },
      { ...auditedProfile, compatibilityDate: "2026-09-30" },
      { ...auditedProfile, compatibilityFlags: ["nodejs_compat"] },
      {
        ...auditedProfile,
        compatibilityFlags: ["legacy_module_registry", "nodejs_compat", "extra_flag"],
      },
    ];

    for (const runtimeProfile of mismatches) {
      expect(classifyNodeBuiltinForProfile(modules, request, runtimeProfile)).toBeUndefined();
    }
  });

  it("does not reuse default evidence for a selected module override", () => {
    const auditedCrypto = { createHash: () => "native" };
    const auditedDefaultModules = { crypto: auditedCrypto };
    const overriddenModules = { crypto: { createHash: () => "replacement" } };

    expect(
      classifyNative(
        overriddenModules,
        {
          specifier: "crypto",
          memberPath: ["createHash"],
        },
        auditedDefaultModules,
      ),
    ).toBeUndefined();
  });

  it("keeps a path declaration local when the callable is shared", () => {
    const tls = { rootCertificates: [] as string[] };
    const events = { some: Array.prototype.some };
    const modules = { tls, events };

    expect(
      classifyNative(modules, {
        specifier: "node:tls",
        memberPath: ["rootCertificates", "some"],
      })?.status,
    ).toBe("supported");
    expect(classifyNative(modules, { specifier: "events", memberPath: ["some"] })).toBeUndefined();
    expect(getNodeBuiltinCapability(Array.prototype.some)).toBeUndefined();
  });

  it("declares storage construction separately from its unsupported methods", () => {
    class AsyncLocalStorage {
      enterWith() {
        throw new Error("not implemented");
      }
      disable() {
        throw new Error("not implemented");
      }
    }
    const modules = { async_hooks: { AsyncLocalStorage } };
    expect(
      classifyNative(modules, { specifier: "async_hooks", memberPath: ["AsyncLocalStorage"] })
        ?.status,
    ).toBe("supported");
    expect(
      classifyNative(modules, {
        specifier: "async_hooks",
        memberPath: ["AsyncLocalStorage", "prototype", "enterWith"],
      }),
    ).toBeUndefined();
    expect(
      classifyNative(modules, {
        specifier: "async_hooks",
        memberPath: ["AsyncLocalStorage", "prototype", "disable"],
      }),
    ).toBeUndefined();
    expect(getNodeBuiltinCapability(AsyncLocalStorage)).toBeUndefined();
  });

  it("preserves audited conditional and unsupported declarations", () => {
    const http2 = { connect: () => "placeholder" };
    const zlib = { gzipSync: () => "conditional" };
    const modules = { http2, zlib };

    expect(classifyNative(modules, { specifier: "http2", memberPath: ["connect"] })?.status).toBe(
      "unsupported",
    );
    expect(
      classifyNative(modules, { specifier: "node:zlib", memberPath: ["gzipSync"] })?.status,
    ).toBe("conditional");
  });

  it("resolves nested and submodule paths without invoking accessors", () => {
    const stream = { promises: { pipeline: () => "nested" } };
    const streamPromises = { pipeline: () => "submodule" };
    const modules = { stream, "stream/promises": streamPromises };
    let getterCalls = 0;
    const crypto = Object.defineProperty({}, "createHash", {
      get() {
        getterCalls += 1;
        return () => "getter";
      },
    });

    expect(
      classifyNative(modules, {
        specifier: "node:stream",
        memberPath: ["promises", "pipeline"],
      })?.status,
    ).toBe("supported");
    expect(
      classifyNative(modules, {
        specifier: "node:stream/promises",
        memberPath: ["pipeline"],
      })?.status,
    ).toBe("supported");
    expect(
      classifyNative({ crypto }, { specifier: "crypto", memberPath: ["createHash"] }),
    ).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  it("leaves a source-listed export unclassified when Workerd omits it", () => {
    const modules = { vm: { runInContext: () => undefined } };

    expect(
      classifyNative(modules, { specifier: "vm", memberPath: ["SourceTextModule"] }),
    ).toBeUndefined();
  });
});

function classifyNodeBuiltinForProfile(
  modules: Readonly<Record<string, object>>,
  request: NodeNativeBuiltinRequest,
  runtimeProfile: NodeNativeRuntimeProfile,
) {
  return classifyNodeNativeBuiltinCapability({
    modules,
    auditedDefaultModules: modules,
    request,
    runtimeProfile,
  });
}
