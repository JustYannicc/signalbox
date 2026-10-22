import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SYSTEM_IDENTITY,
  systemHostname,
  systemIdentityForThread,
} from "@t3tools/contracts/systemIdentity";

describe("shared system identity", () => {
  it("uses one configured image and a stable thread hostname", () => {
    const identity = systemIdentityForThread("thread-1", {
      release: "6.12.8-production",
      version: "#1 SMP PREEMPT_DYNAMIC",
      machine: "aarch64",
      hostnamePolicy: "thread",
      verification: "measured",
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
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(DEFAULT_SYSTEM_IDENTITY.verification).toBe("provisional");
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
});
