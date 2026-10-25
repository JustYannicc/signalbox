import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SYSTEM_IDENTITY,
  DEFAULT_SYSTEM_RESOURCES,
  SystemIdentity,
  sameSystemIdentity,
  systemHostname,
  systemIdentityForThread,
} from "@t3tools/contracts/systemIdentity";

const decodeSystemIdentity = Schema.decodeUnknownSync(SystemIdentity);

describe("shared system identity", () => {
  it("uses one configured image and a stable thread hostname", () => {
    const identity = systemIdentityForThread("thread-1", {
      release: "6.12.8-production",
      version: "#1 SMP PREEMPT_DYNAMIC",
      machine: "aarch64",
      hostnamePolicy: "thread",
      verification: "measured",
      resources: { memoryBytes: 8 * 1024 ** 3, vcpus: 6, profile: "steady" },
    });
    expect(identity).toEqual({
      release: "6.12.8-production",
      version: "#1 SMP PREEMPT_DYNAMIC",
      machine: "aarch64",
      hostnamePolicy: "thread",
      verification: "measured",
      hostname: "t-thread-1",
      platform: "linux",
      type: "Linux",
      arch: "arm64",
      endianness: "LE",
      resources: { memoryBytes: 8 * 1024 ** 3, vcpus: 6, profile: "steady" },
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.resources)).toBe(true);
    expect(DEFAULT_SYSTEM_IDENTITY.verification).toBe("measured");
    expect(DEFAULT_SYSTEM_RESOURCES).toEqual({
      memoryBytes: 4 * 1024 ** 3,
      vcpus: 1,
      profile: "steady",
    });
  });

  it("keeps hostnames valid and stable for opaque or long thread ids", () => {
    for (const threadId of ["x", "thread:Unicode-ä", "x".repeat(200)]) {
      const hostname = systemHostname(threadId);
      expect(hostname).toBe(systemHostname(threadId));
      expect(hostname).toMatch(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
      expect(hostname.length).toBeLessThanOrEqual(63);
    }
    expect(systemHostname("x".repeat(200) + "a")).not.toBe(systemHostname("x".repeat(200) + "b"));
    expect(() => systemHostname("")).toThrow(TypeError);
    expect(() =>
      systemIdentityForThread("thread-1", { ...DEFAULT_SYSTEM_IDENTITY, release: "" }),
    ).toThrow();
  });

  it("defaults legacy identities and configs to modeled resources", () => {
    const legacyConfig = {
      release: "6.12.0",
      version: "#1 SMP",
      machine: "x86_64",
      hostnamePolicy: "thread",
      verification: "provisional",
    } as const;
    const resolved = systemIdentityForThread("legacy-thread", legacyConfig);
    const legacyIdentityInput: Record<string, unknown> = { ...resolved };
    delete legacyIdentityInput.resources;
    const legacyIdentity = decodeSystemIdentity(legacyIdentityInput);

    expect(resolved.resources).toEqual(DEFAULT_SYSTEM_RESOURCES);
    expect(legacyIdentity.resources).toEqual(DEFAULT_SYSTEM_RESOURCES);
    expect(sameSystemIdentity(legacyIdentityInput as unknown as SystemIdentity, resolved)).toBe(
      true,
    );
  });

  it("rejects invalid resource capacities during identity resolution and compares them", () => {
    const identity = systemIdentityForThread("thread-1");
    const changed = systemIdentityForThread("thread-1", {
      ...DEFAULT_SYSTEM_IDENTITY,
      resources: { memoryBytes: 8 * 1024 ** 3, vcpus: 4, profile: "steady" },
    });

    expect(sameSystemIdentity(identity, identity)).toBe(true);
    expect(sameSystemIdentity(identity, changed)).toBe(false);
    expect(sameSystemIdentity(undefined, undefined)).toBe(true);
    expect(sameSystemIdentity(identity, undefined)).toBe(false);

    for (const resources of [
      { memoryBytes: 0, vcpus: 2, profile: "steady" },
      { memoryBytes: 64 * 1024 * 1024 - 1, vcpus: 2, profile: "steady" },
      { memoryBytes: 64 * 1024 * 1024, vcpus: 0, profile: "steady" },
      { memoryBytes: Number.MAX_SAFE_INTEGER + 1, vcpus: 2, profile: "steady" },
      { memoryBytes: 64 * 1024 * 1024 + 0.5, vcpus: 2, profile: "steady" },
      { memoryBytes: 64 * 1024 * 1024, vcpus: 257, profile: "steady" },
      { memoryBytes: 64 * 1024 * 1024, vcpus: 2, profile: "unknown" },
    ]) {
      expect(() =>
        systemIdentityForThread("thread-1", {
          ...DEFAULT_SYSTEM_IDENTITY,
          resources,
        } as never),
      ).toThrow();
    }
  });
});
