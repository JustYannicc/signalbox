import { operations } from "@signalbox/api/catalog";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { descriptor } from "../environment.ts";
import { CLOUD_UNSERVED, cloudServes, cloudUnserved, coverageKeyMatches } from "./cloudCoverage.ts";

describe("cloud API coverage", () => {
  it("serves workflow inspection and stop through the generated API and MCP reach", () => {
    for (const [name, access] of [
      ["threads.getWorkflowScript", "read"],
      ["threads.stopWorkflow", "write"],
    ]) {
      const operation = operations.find((candidate) => candidate.name === name)!;
      expect(operation.access).toBe(access);
      expect(operation.humanOnly).toBe(false);
      expect(operation.destructive).toBe(false);
      expect(cloudServes(operation)).toBe(true);
      expect(cloudUnserved(operation)).toBeUndefined();
    }
  });

  it("tracks usage history as missing rather than treating account quotas as its replacement", () => {
    const { capabilities } = descriptor({
      environmentId: EnvironmentId.make("cloud"),
      label: "Cloud",
    });
    expect(capabilities.usageHistory).toBe(false);
    expect(capabilities.usageLimitSources).toBe(true);
    const usage = operations.filter((operation) => operation.name.startsWith("usage."));
    expect(usage.map((operation) => operation.name).sort()).toEqual([
      "usage.refreshRates",
      "usage.summary",
    ]);
    for (const operation of usage) {
      expect(cloudServes(operation)).toBe(false);
      expect(cloudUnserved(operation)).toEqual({ _tag: "gap", issue: "#786" });
    }
  });

  it("serves queued edits and reorders through the cloud decider", () => {
    for (const name of ["threads.queuedRun.edit", "threads.queuedRun.reorder"]) {
      const operation = operations.find((candidate) => candidate.name === name);
      if (operation === undefined) throw new Error(`Missing ${name}`);
      expect(cloudServes(operation)).toBe(true);
      expect(cloudUnserved(operation)).toBeUndefined();
    }
  });

  it("serves both keybinding edits rather than leaving the editor with unknown RPCs", () => {
    const keybindings = operations.filter((operation) => operation.name.startsWith("keybindings."));
    expect(keybindings.map((operation) => operation.name).sort()).toEqual([
      "keybindings.remove",
      "keybindings.upsert",
    ]);
    expect(
      keybindings.filter((operation) => !cloudServes(operation)).map((operation) => operation.name),
    ).toEqual([]);
  });

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
    for (const name of [
      "pullRequests.comment",
      "pullRequests.updateComment",
      "pullRequests.submitReview",
      "pullRequests.setReaction",
      "pullRequests.replyToThread",
      "pullRequests.setThreadResolution",
    ]) {
      const operation = operations.find((entry) => entry.name === name)!;
      expect(cloudServes(operation)).toBe(true);
      expect(cloudUnserved(operation)).toBeUndefined();
    }
  });

  it("serves starting a folder from another folder through the cloud RPC", () => {
    const operation = operations.find((candidate) => candidate.name === "folders.startFrom");
    expect(operation).toBeDefined();
    expect(cloudServes(operation!)).toBe(true);
    expect(cloudUnserved(operation!)).toBeUndefined();
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
