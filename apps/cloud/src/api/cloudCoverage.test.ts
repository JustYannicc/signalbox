import { operations } from "@signalbox/api/catalog";
import { describe, expect, it } from "vite-plus/test";

import { CLOUD_UNSERVED, cloudServes, cloudUnserved, coverageKeyMatches } from "./cloudCoverage.ts";

describe("cloud API coverage", () => {
  it("serves analytics preferences instead of leaving Settings with unknown RPCs", () => {
    const analytics = operations.filter((operation) => operation.name.startsWith("analytics."));
    expect(analytics.map((operation) => operation.name).sort()).toEqual([
      "analytics.get",
      "analytics.setEnabled",
    ]);
    expect(
      analytics.filter((operation) => !cloudServes(operation)).map((operation) => operation.name),
    ).toEqual([]);
  });

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

  it("serves every pull-request read in #814", () => {
    const names = new Set([
      "pullRequests.list",
      "pullRequests.listStats",
      "pullRequests.summary",
      "pullRequests.routing",
      "pullRequests.routingIdentity",
      "pullRequests.stack",
      "pullRequests.linkedThreads",
      "pullRequests.detail",
      "pullRequests.preview",
      "pullRequests.checks",
      "pullRequests.activity",
      "pullRequests.threadComments",
      "pullRequests.diffFileContents",
      "pullRequests.refresh",
      "pullRequests.subscribeRefreshes",
      "git.resolvePullRequest",
    ]);
    const reads = operations.filter((operation) => names.has(operation.name));
    expect(reads.map((operation) => operation.name).sort()).toEqual([...names].sort());
    for (const operation of reads) {
      expect(cloudServes(operation), operation.name).toBe(true);
      expect(cloudUnserved(operation), operation.name).toBeUndefined();
    }
  });

  it("serves every operation or says why not", () => {
    const silent = operations
      .filter((operation) => !cloudServes(operation) && cloudUnserved(operation) === undefined)
      .map((operation) => operation.name);
    expect(silent).toEqual([]);
  });

  it("serves review replies and resolution through the public API", () => {
    for (const name of ["pullRequests.replyToThread", "pullRequests.setThreadResolution"]) {
      const operation = operations.find((entry) => entry.name === name)!;
      expect(cloudServes(operation)).toBe(true);
      expect(cloudUnserved(operation)).toBeUndefined();
    }
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
