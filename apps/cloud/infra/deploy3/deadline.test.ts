import { isoAt } from "./platform.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createDeploy3Name, effectiveDeploy3Deadline, parseDeploy3Name } from "./deadline.ts";

const deadlineMs = 2_000_000_000_000;
const name = createDeploy3Name({ runId: "a1b2c3d4", deadlineMs, role: "workload" });

NodeTest.test("creates and parses the exact canonical name", () => {
  NodeAssert.equal(name, "sb1070-d3-a1b2c3d4-2000000000-workload");
  NodeAssert.deepEqual(parseDeploy3Name(name), {
    runId: "a1b2c3d4",
    deadlineMs,
    deadlineUtc: isoAt(deadlineMs),
    role: "workload",
  });
  NodeAssert.equal(
    createDeploy3Name({ runId: "a1b2c3d4", deadlineMs: deadlineMs + 1, role: "cleanup" }),
    "sb1070-d3-a1b2c3d4-2000000001-cleanup",
  );
});

NodeTest.test("refuses wrong prefixes, segments, roles, timestamp lengths, and overflow", () => {
  for (const candidate of [
    name.replace("sb1070-d3-", "sb1070-"),
    name.replace("a1b2c3d4", "A1b2c3d4"),
    name.replace("-workload", "-other"),
    name.replace("2000000000", "200000000"),
    "sb1070-d3-a1b2c3d4-99999999999-workload",
    "sb1070-d3-a1b2c3d4-2000000000-workload-extra",
  ]) {
    NodeAssert.equal(parseDeploy3Name(candidate), null, candidate);
  }
  NodeAssert.throws(() =>
    createDeploy3Name({ runId: "a1b2c3d4", deadlineMs: Number.MAX_SAFE_INTEGER, role: "workload" }),
  );
  NodeAssert.throws(() => createDeploy3Name({ runId: "A1b2c3d4", deadlineMs, role: "workload" }));
});

NodeTest.test("missing deadline tag uses the name and one monotonic tag overrides it", () => {
  NodeAssert.deepEqual(effectiveDeploy3Deadline(name), parseDeploy3Name(name));
  NodeAssert.deepEqual(
    effectiveDeploy3Deadline(name, ["team:deploy3", "sb1070-d3-deadline-2000003600"]),
    {
      runId: "a1b2c3d4",
      deadlineMs: 2_000_003_600_000,
      deadlineUtc: isoAt(2_000_003_600_000),
      role: "workload",
    },
  );
});

NodeTest.test("malformed, duplicate, and nonmonotonic deadline tags refuse the resource", () => {
  for (const tags of [
    ["sb1070-d3-deadline-nope"],
    ["sb1070-d3-deadline-2000000000", "sb1070-d3-deadline-2000003600"],
    ["sb1070-d3-deadline-1999999999"],
    ["sb1070-d3-deadline-99999999999"],
  ]) {
    NodeAssert.equal(effectiveDeploy3Deadline(name, tags), null);
  }
  NodeAssert.equal(effectiveDeploy3Deadline(name, null as unknown as string[]), null);
});
