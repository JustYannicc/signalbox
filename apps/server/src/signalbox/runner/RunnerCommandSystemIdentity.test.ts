import { describe, expect, it, vi } from "vite-plus/test";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

import {
  applyRunnerCommandSystemIdentity,
  resolveRunnerCommandSystemIdentity,
  sameSystemIdentity,
  type RunnerCommandSystemIdentitySystem,
} from "./RunnerCommandSystemIdentity.ts";

const identity = (verification: "provisional" | "measured" = "provisional") =>
  systemIdentityForThread("command-thread-1", {
    release: "6.12.0-configured",
    version: "#7 SMP",
    machine: "x86_64",
    hostnamePolicy: "thread",
    verification,
  });

const systemFixture = (expected = identity()) => {
  let hostname = "boxd-random-host";
  const events: string[] = [];
  const system: RunnerCommandSystemIdentitySystem = {
    platform: () => "linux",
    type: () => "Linux",
    arch: () => expected.arch,
    machine: () => expected.machine,
    endianness: () => "LE",
    release: () => "6.99.0-native",
    version: () => "native kernel version",
    hostname: () => {
      events.push("hostname");
      return hostname;
    },
    setHostname: vi.fn((value: string) => {
      events.push("setHostname");
      hostname = value;
    }),
  };
  return { system, events };
};

describe("command Runner system identity", () => {
  it("resolves legacy config with shared defaults and rejects hostnames bound to another thread", () => {
    const expected = systemIdentityForThread("command-thread-1");
    expect(resolveRunnerCommandSystemIdentity("command-thread-1")).toEqual(expected);
    expect(() =>
      resolveRunnerCommandSystemIdentity("command-thread-1", systemIdentityForThread("other")),
    ).toThrow("does not match its thread");
  });

  it("includes configured resources when comparing identities", () => {
    const configured = identity();
    const changedResources = systemIdentityForThread("command-thread-1", {
      ...configured,
      resources: { memoryBytes: 8 * 1024 ** 3, vcpus: 4, profile: "steady" },
    });

    expect(sameSystemIdentity(configured, changedResources)).toBe(false);
  });

  it("sets and reads back the native hostname without comparing provisional release data", () => {
    const expected = identity();
    const fixture = systemFixture(expected);

    expect(applyRunnerCommandSystemIdentity(expected, fixture.system)).toEqual(expected);
    expect(fixture.system.setHostname).toHaveBeenCalledOnce();
    expect(fixture.system.setHostname).toHaveBeenCalledWith(expected.hostname);
    expect(fixture.events).toEqual(["setHostname", "hostname"]);
  });

  it("requires measured release and version to match before changing the machine", () => {
    const expected = identity("measured");
    const fixture = systemFixture(expected);

    expect(() => applyRunnerCommandSystemIdentity(expected, fixture.system)).toThrow(
      "release or version",
    );
    expect(fixture.system.setHostname).not.toHaveBeenCalled();
  });

  it("always checks the native platform, architecture, and machine before setting hostname", () => {
    const expected = identity();
    const fixture = systemFixture(expected);
    const mismatched = { ...fixture.system, machine: () => "aarch64" };

    expect(() => applyRunnerCommandSystemIdentity(expected, mismatched)).toThrow(
      "platform identity",
    );
    expect(fixture.system.setHostname).not.toHaveBeenCalled();
  });
});
