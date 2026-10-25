import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { BuiltinToolCall } from "@signalbox/automations/builtinTools/runner";
import type { GitHubActions } from "../github/GitHubActions.ts";
import type { HarnessReleaseLedgerService } from "../harnessReleases/HarnessReleaseLedgerService.ts";
import { makeCloudBuiltinTools } from "./cloudBuiltinTools.ts";

const callFor = (tool: string, args: unknown): BuiltinToolCall => ({
  tool,
  args,
  automationId: "automation-1",
  projectId: "project-from-run",
  runId: "run-1",
  automationName: "Watch harness releases",
  runtimeMode: "auto" as BuiltinToolCall["runtimeMode"],
  requestKey: "step-1",
});

describe("Cloud automation GitHub operations", () => {
  it.effect("uses the run's project for workflow dispatch and ignores an argument project ID", () =>
    Effect.gen(function* () {
      const projectIds: string[] = [];
      const github = {
        workflowDispatch: (projectId: string, input: unknown) => {
          projectIds.push(projectId);
          return Effect.succeed({ projectId, input });
        },
      } as unknown as GitHubActions["Service"];
      const handler = makeCloudBuiltinTools({
        threads: {} as never,
        service: {} as never,
        owner: Effect.succeed({} as never),
        merges: {} as never,
        github,
        folders: {} as never,
        harnessReleaseLedger: {
          call: () => Effect.succeed({}),
        } as never as HarnessReleaseLedgerService["Service"],
      });
      const result = yield* handler.call(
        callFor("github_workflow", {
          action: "dispatch",
          projectId: "untrusted-input",
          workflowFile: ".github/workflows/harness-release-proof.yml",
          ref: "main",
          headSha: "a".repeat(40),
          correlationId: "harness-release:codex:1.2.3",
          inputs: {
            provider: "codex",
            version: "1.2.3",
            runKey: "harness-release:codex:1.2.3",
            selection: "current",
          },
        }),
      );

      expect(projectIds).toEqual(["project-from-run"]);
      expect(result).toMatchObject({
        projectId: "project-from-run",
        input: {
          workflowFile: ".github/workflows/harness-release-proof.yml",
          headSha: "a".repeat(40),
        },
      });
    }),
  );

  it.effect("decodes the ledger request before a run-scoped service call", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const handler = makeCloudBuiltinTools({
        threads: {} as never,
        service: {} as never,
        owner: Effect.succeed({} as never),
        merges: {} as never,
        github: {} as never,
        folders: {} as never,
        harnessReleaseLedger: {
          selection: (projectId: string, provider: string) => {
            calls.push(["selection", projectId, provider]);
            return Effect.succeed({ revision: 0 });
          },
          record: () => {
            calls.push(["record"]);
            return Effect.succeed({ status: "pending" });
          },
          promote: () => {
            calls.push(["promote"]);
            return Effect.succeed({ status: "pending" });
          },
        } as never as HarnessReleaseLedgerService["Service"],
      });

      expect(handler.policies).toMatchObject({
        harness_release_ledger: { requiresVouch: true, projectScope: "run" },
        github_workflow: { requiresVouch: true, projectScope: "run" },
        github_issue: { requiresVouch: true, projectScope: "run" },
      });
      yield* handler.call(
        callFor("harness_release_ledger", {
          action: "selection",
          provider: "codex",
          projectId: "untrusted-input",
        }),
      );
      expect(calls).toEqual([["selection", "project-from-run", "codex"]]);

      const invalid = yield* Effect.result(
        handler.call(
          callFor("harness_release_ledger", {
            action: "record",
            provider: "codex",
            version: "1.2.3",
            selection: "current",
            runKey: "harness-release:codex:1.2.3",
            headSha: "a".repeat(40),
            workflowFile: ".github/workflows/harness-release-proof.yml",
            workflowRunId: "12345",
            artifactName: "harness-release-codex-1.2.3-12345-1",
            entryPath: "unexpected.json",
          }),
        ),
      );
      expect(invalid._tag).toBe("Failure");
      expect(calls).toHaveLength(1);
    }),
  );
});
