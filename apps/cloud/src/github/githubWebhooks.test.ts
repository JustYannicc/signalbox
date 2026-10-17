import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePullRequestThread } from "../automations/pullRequestThreadTesting.ts";
import { hookTestSetup, HOOK_USER, signedBody } from "../automations/hookTesting.ts";
import type { HookRequest } from "../automations/webhookRequest.ts";
import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import { GitHubWebhooks } from "./GitHubWebhooks.ts";
import { deliveredRemarks } from "./githubEventDelivery.ts";
import { gitHubSignals, parseGitHubPayload } from "./githubEvents.ts";

const source = `export const meta = { name: "Read GitHub facts", overlap: "allow", triggers: [{ on: "pr.opened", where: { repository: "Owner/Repo" } }] } as const;
export default workflow(async (_w, pr: unknown) => pr);`;

describe("GitHub webhook events", () => {
  it.effect(
    "a signed GitHub delivery starts a cloud run with current PR facts exactly once",
    () => {
      const fixture = makePullRequestThread();
      const { cloud, github, open, run, tool } = fixture;
      return Effect.gen(function* () {
        yield* open;
        github.update(1, {
          checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }],
          openThreads: 2,
        });
        const compiled = compileForCloud(source);
        if (!compiled.ok) return yield* Effect.die(compiled.diagnostics);
        const saved = (yield* tool("automation_save", { source, compiled: compiled.compiled })) as {
          automation: { automationId: string };
        };
        const automationId = saved.automation.automationId;
        const row = (yield* cloud.inUser(
          "user_1",
          GitHubWebhooks.use((hooks) => hooks.store.list),
        ))[0]!;
        const body = JSON.stringify({
          action: "opened",
          repository: { full_name: "Owner/Repo" },
          pull_request: { number: 1 },
        });
        const signature = yield* Effect.promise(() => signedBody(body, row.secret));
        const request: HookRequest = {
          hookId: row.id,
          token: "",
          method: "POST",
          query: "",
          body: new TextEncoder().encode(body),
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "github-delivery-1",
            "x-hub-signature-256": signature,
          },
        };
        const user = cloud.userDirectory.forUser("user_1");
        expect(
          yield* user.receiveHook({ ...request, body: new TextEncoder().encode(`${body} `) }),
        ).toEqual({ status: 401 });
        for (const invalid of [undefined, "sha256=not-hex", "sha256=ab", signature.slice(7)]) {
          const headers = { ...request.headers };
          if (invalid === undefined) delete headers["x-hub-signature-256"];
          else headers["x-hub-signature-256"] = invalid;
          expect(yield* user.receiveHook({ ...request, headers })).toEqual({ status: 401 });
        }
        const first = yield* user.receiveHook(request);
        expect(first).toMatchObject({ status: 202, duplicate: false });
        expect(yield* user.receiveHook(request)).toEqual({ ...first, duplicate: true });
        yield* cloud.fireAlarm("user_1");
        yield* cloud.settle;
        const detail = yield* cloud.inUser(
          "user_1",
          WorkflowEngine.use((engine) => engine.get(automationId)),
        );
        expect(detail.runs).toHaveLength(1);
        const done = yield* fixture.getRun(detail.runs[0]!.id);
        expect(done.run.status).toBe("succeeded");
        expect(done.output).toMatchObject({
          event: "pr.opened",
          repository: "owner/repo",
          number: 1,
          state: "open",
          mergeability: "mergeable",
          checksState: "passing",
          openThreads: 2,
          baseBranch: "main",
          headBranch: expect.any(String),
          labels: [],
          reviews: [],
          headSha: expect.any(String),
          baseSha: expect.any(String),
        });
        expect(yield* user.receiveHook(request)).toEqual({ ...first, duplicate: true });
        yield* cloud.fireAlarm("user_1");
        expect(
          (yield* cloud.inUser(
            "user_1",
            WorkflowEngine.use((engine) => engine.get(automationId)),
          )).runs,
        ).toHaveLength(1);
        const checkSource = source
          .replace("Read GitHub facts", "Read check facts")
          .replace("pr.opened", "pr.checks.completed");
        const checkCompiled = compileForCloud(checkSource);
        if (!checkCompiled.ok) return yield* Effect.die(checkCompiled.diagnostics);
        const checkSaved = (yield* tool("automation_save", {
          source: checkSource,
          compiled: checkCompiled.compiled,
        })) as { automation: { automationId: string } };
        const deliverCheck = (sha: string, deliveryId: string) =>
          Effect.gen(function* () {
            const checkBody = JSON.stringify({
              action: "completed",
              repository: { full_name: "owner/repo" },
              check_suite: { head_sha: sha, pull_requests: [{ number: 1 }] },
            });
            const checkSignature = yield* Effect.promise(() => signedBody(checkBody, row.secret));
            yield* user.receiveHook({
              ...request,
              body: new TextEncoder().encode(checkBody),
              headers: {
                "x-github-event": "check_suite",
                "x-github-delivery": deliveryId,
                "x-hub-signature-256": checkSignature,
              },
            });
            yield* cloud.fireAlarm("user_1");
            yield* cloud.settle;
            return yield* cloud.inUser(
              "user_1",
              WorkflowEngine.use((engine) => engine.get(checkSaved.automation.automationId)),
            );
          });
        expect((yield* deliverCheck("older-head", "stale-check-delivery")).runs).toHaveLength(0);
        expect(
          (yield* deliverCheck(github.head(github.pulls[0]!.head)!, "current-check-delivery")).runs,
        ).toHaveLength(1);
      }).pipe(run);
    },
  );

  it.effect(
    "removes a paused subscription without a remote hook while GitHub is disconnected",
    () =>
      Effect.gen(function* () {
        const { cloud } = yield* hookTestSetup();
        yield* cloud.inUser(
          HOOK_USER,
          GitHubWebhooks.use((hooks) =>
            Effect.gen(function* () {
              yield* hooks.store.insert({
                id: "subscription-1",
                secret: "secret",
                projectId: "project-1",
                repository: "owner/repo",
                events: ["release"],
              });
              yield* hooks.store.disable("subscription-1");
              yield* hooks.sync;
              expect(yield* hooks.store.list).toEqual([]);
            }),
          ),
        );
      }),
  );

  it("keeps the delivered review even when it arrives after the day it was posted", () => {
    expect(
      deliveredRemarks("pr.reviewed", {
        id: 42,
        user: { login: "reviewer" },
        body: "Fix this",
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-10-10T00:00:00Z",
        html_url: "https://github.test/review/42",
      }),
    ).toEqual([
      {
        id: "42",
        kind: "review",
        author: "reviewer",
        body: "Fix this",
        path: null,
        reviewState: "CHANGES_REQUESTED",
        at: "2026-10-10T00:00:00Z",
        url: "https://github.test/review/42",
      },
    ]);
  });

  it("maps lifecycle, check, review, comment, release and issue events", () => {
    const parse = (extra: object) =>
      parseGitHubPayload(JSON.stringify({ repository: { full_name: "owner/repo" }, ...extra }))!;
    expect(
      gitHubSignals(
        "pull_request",
        parse({ action: "closed", pull_request: { number: 1, merged: true } }),
      )[0]?.events,
    ).toEqual(["pr.updated", "pr.merged"]);
    expect(
      gitHubSignals(
        "pull_request",
        parse({ action: "synchronize", pull_request: { number: 1 } }),
      )[0]?.events,
    ).toEqual(["pr.updated"]);
    expect(
      gitHubSignals(
        "check_suite",
        parse({
          action: "completed",
          check_suite: { head_sha: "new", pull_requests: [{ number: 1 }, { number: 2 }] },
        }),
      ),
    ).toHaveLength(2);
    expect(
      gitHubSignals(
        "check_run",
        parse({
          action: "in_progress",
          check_run: { head_sha: "new", pull_requests: [{ number: 1 }] },
        }),
      ),
    ).toEqual([]);
    expect(
      gitHubSignals(
        "pull_request_review",
        parse({ action: "submitted", pull_request: { number: 1 }, review: { state: "APPROVED" } }),
      )[0]?.events,
    ).toEqual(["pr.reviewed"]);
    expect(
      gitHubSignals(
        "issue_comment",
        parse({
          action: "created",
          issue: {
            number: 1,
            title: "PR",
            body: "",
            html_url: "url",
            labels: [],
            user: null,
            pull_request: {},
          },
        }),
      )[0]?.events,
    ).toEqual(["pr.commented"]);
    expect(
      gitHubSignals(
        "issues",
        parse({
          action: "opened",
          issue: {
            number: 2,
            title: "Bug",
            body: "text",
            html_url: "url",
            labels: [{ name: "bug" }],
            user: { login: "a" },
          },
        }),
      )[0]?.fields,
    ).toMatchObject({ number: 2, labels: ["bug"] });
    expect(
      gitHubSignals(
        "release",
        parse({
          action: "published",
          release: {
            id: 5,
            tag_name: "v5",
            name: null,
            html_url: "url",
            prerelease: false,
            published_at: "2026-10-17T00:00:00Z",
          },
        }),
      )[0]?.events,
    ).toEqual(["release.published"]);
  });
});
