import { operations } from "@signalbox/api/catalog";
import { describe, expect, it } from "vite-plus/test";

import { CLOUD_UNSERVED, cloudServes, cloudUnserved, coverageKeyMatches } from "./cloudCoverage.ts";

describe("cloud API coverage", () => {
  it("reports deferred cloud terminals as tracked gaps", () => {
    const terminals = operations.filter((operation) =>
      /^(terminal\.|terminalEvents\.|terminalMetadata\.)/.test(operation.name),
    );
    expect(terminals).toHaveLength(9);
    for (const operation of terminals) {
      expect(cloudServes(operation)).toBe(false);
      expect(cloudUnserved(operation)).toEqual({ _tag: "gap", issue: "#744" });
    }
  });

  it("serves every operation or says why not", () => {
    const silent = operations
      .filter((operation) => !cloudServes(operation) && cloudUnserved(operation) === undefined)
      .map((operation) => operation.name);
    expect(silent).toEqual([]);
  });

  it("lists nothing the cloud serves", () => {
    const stale = operations
      .filter((operation) => cloudServes(operation) && cloudUnserved(operation) !== undefined)
      .map((operation) => operation.name);
    expect(stale).toEqual([]);
  });

  it("matches every listed key to an operation, and each operation to one key", () => {
    const keys = Object.keys(CLOUD_UNSERVED);
    const unused = keys.filter(
      (key) => !operations.some((operation) => coverageKeyMatches(key, operation.name)),
    );
    const overlapping = operations
      .filter(
        (operation) => keys.filter((key) => coverageKeyMatches(key, operation.name)).length > 1,
      )
      .map((operation) => operation.name);
    expect({ unused, overlapping }).toEqual({ unused: [], overlapping: [] });
  });

  it("gives every exemption a reason", () => {
    const empty = Object.entries(CLOUD_UNSERVED)
      .filter(([, unserved]) => unserved._tag === "exempt" && unserved.reason.trim() === "")
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });
});
