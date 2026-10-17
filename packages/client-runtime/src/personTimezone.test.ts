import { describe, expect, it, vi } from "@effect/vitest";
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import {
  connectedPersonTimezoneEnvironmentIds,
  DeviceTimezoneReportCache,
  detectDeviceTimezone,
  personTimezoneErrorMessage,
  permittedPersonTimezoneEnvironmentIds,
  PersonTimezoneReportCoordinator,
  supportedTimezones,
  supportsPersonTimezone,
} from "@t3tools/client-runtime/personTimezone";

describe("person timezone client helpers", () => {
  it("reads the client's IANA time zone and offers searchable supported zones", () => {
    const timezone = detectDeviceTimezone();
    expect(timezone).not.toBeNull();

    const zones = supportedTimezones(timezone);
    expect(zones).toContain("UTC");
    expect(zones).toContain(timezone);
    expect(zones).toEqual([...zones].toSorted((left, right) => left.localeCompare(right)));
  });

  it("requires an explicit person timezone capability", () => {
    expect(supportsPersonTimezone(undefined)).toBe(false);
    expect(supportsPersonTimezone({ personTimezone: false })).toBe(false);
    expect(supportsPersonTimezone({ personTimezone: true })).toBe(true);
  });

  it("offers a browsable catalog and preserves saved aliases without Intl enumeration", () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    for (const supportedValuesOf of [
      undefined,
      () => [],
      () => {
        throw new RangeError("Unsupported enumeration");
      },
    ]) {
      vi.stubGlobal("Intl", { DateTimeFormat, supportedValuesOf });
      try {
        const zones = supportedTimezones("US/Eastern");
        expect(zones.length).toBeGreaterThan(300);
        expect(zones).toEqual(
          expect.arrayContaining(["UTC", "Europe/Zurich", "Asia/Kathmandu", "US/Eastern"]),
        );
        expect(new Set(zones).size).toBe(zones.length);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("shows a backend error message and falls back for failures without one", () => {
    expect(
      personTimezoneErrorMessage(Cause.fail({ message: "Timezone unavailable" }), "Try again"),
    ).toBe("Timezone unavailable");
    expect(personTimezoneErrorMessage(Cause.interrupt(), "Try again")).toBe("Try again");
    expect(personTimezoneErrorMessage(Cause.fail("untyped failure"), "Try again")).toBe(
      "Try again",
    );
  });

  it("selects only connected cloud environments with report permission", () => {
    const capabilities = { personTimezone: true } as ExecutionEnvironmentCapabilities;
    const environments = [
      {
        environmentId: "connected-cloud",
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities } },
      },
      {
        environmentId: "disconnected-cloud",
        connection: { phase: "offline" },
        serverConfig: { environment: { capabilities } },
      },
      {
        environmentId: "connected-local",
        connection: { phase: "connected" },
        serverConfig: {
          environment: { capabilities: { personTimezone: false } as typeof capabilities },
        },
      },
    ];
    const connected = connectedPersonTimezoneEnvironmentIds(environments);
    expect(connected).toEqual(["connected-cloud"]);
    expect(permittedPersonTimezoneEnvironmentIds(connected, [true])).toEqual(["connected-cloud"]);
    expect(permittedPersonTimezoneEnvironmentIds(connected, [false])).toEqual([]);
  });

  it("reports newly connected environments and forces the active client's zone on foreground", () => {
    const coordinator = new PersonTimezoneReportCoordinator<string>();
    const reported: Array<[string, string]> = [];
    const report = async (environmentId: string, timezone: string) => {
      reported.push([environmentId, timezone]);
      return true;
    };

    coordinator.setActiveEnvironmentIds(["cloud"], report);
    coordinator.setActiveEnvironmentIds(["cloud"], report);
    expect(reported).toHaveLength(1);

    coordinator.reportOnForeground(report);
    expect(reported).toHaveLength(2);

    coordinator.setActiveEnvironmentIds([], report);
    coordinator.setActiveEnvironmentIds(["cloud"], report);
    expect(reported).toHaveLength(3);
    expect(
      reported.every(([environmentId, timezone]) => environmentId === "cloud" && timezone),
    ).toBe(true);
  });

  it("deduplicates unchanged reports but retries after failure or reconnection", () => {
    const cache = new DeviceTimezoneReportCache<string>();
    expect(cache.shouldReport("cloud", "Europe/Zurich")).toBe(true);
    expect(cache.shouldReport("cloud", "Europe/Zurich")).toBe(false);
    expect(cache.shouldReport("cloud", "Europe/Zurich", true)).toBe(true);

    cache.failed("cloud");
    expect(cache.shouldReport("cloud", "Europe/Zurich")).toBe(true);
    cache.forget("cloud");
    expect(cache.shouldReport("cloud", "Europe/Zurich")).toBe(true);
  });
});
