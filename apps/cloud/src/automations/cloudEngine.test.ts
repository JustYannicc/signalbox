// @effect-diagnostics globalDateInEffect:off - this test fakes `Date` for the object's alarm.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeRepo } from "../drive/driveTesting.ts";
import { makeFakeGitHub } from "../github/githubTesting.ts";
import { hookTestSetup, HOOK_USER } from "./hookTesting.ts";

const DRIVE = `my/personal/${HOOK_USER}`;
const HOOK_ORIGIN = "http://localhost:8787/api/github/callback";
const repos: Array<ReturnType<typeof makeRepo>> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const repo of repos.splice(0)) repo.cleanup();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cloud automation flush", () => {
  it.effect("retries GitHub reconciliation without losing mutations or earlier work alarms", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T12:00:30.000Z"));
      yield* TestClock.setTime(Date.now());

      const repo = makeRepo();
      repos.push(repo);
      const installed: Array<{
        readonly id: number;
        readonly url: string;
        readonly events: ReadonlyArray<string>;
      }> = [];
      let nextHookId = 1;
      const github = makeFakeGitHub({
        bare: repo.dir,
        repository: "owner/repo",
        defaultBranch: "main",
        more: (method, url, body) => {
          if (url.pathname === "/repos/owner/repo/hooks") {
            if (method === "GET")
              return json(installed.map((hook) => ({ id: hook.id, config: { url: hook.url } })));
            if (method === "POST") {
              const input = JSON.parse(new TextDecoder().decode(body)) as {
                readonly config: { readonly url: string };
                readonly events: ReadonlyArray<string>;
              };
              const hook = {
                id: nextHookId++,
                url: input.config.url,
                events: input.events,
              };
              installed.push(hook);
              return json({ id: hook.id }, 201);
            }
          }
          return null;
        },
      });
      const { cloud, save, engine } = yield* hookTestSetup({ github: github.layer });
      const user = cloud.userDirectory.forUser(HOOK_USER);
      yield* user.beginGitHubConnect({ grantId: "g1", returnTo: HOOK_ORIGIN });
      github.authorize(HOOK_USER);
      yield* user.completeGitHubConnect("g1");

      const drive = cloud.drives.apiFor(DRIVE);
      yield* Effect.promise(() =>
        drive.setRemote({ provider: "github", repository: "owner/repo", defaultBranch: "main" }),
      );

      const remote = vi.spyOn(drive, "remote");
      const prSource = `export const meta = { name: "Read PR", triggers: [{ on: "pr.opened" }] } as const;
export default workflow(async (_w, pr: unknown) => pr);`;

      const failedAt = Date.now();
      remote.mockRejectedValueOnce(new Error("drive remote is temporarily unavailable"));
      const prAutomation = yield* save(prSource);
      expect(prAutomation.name).toBe("Read PR");
      expect(cloud.alarmAt(HOOK_USER)).toBe(failedAt + 60_000);
      expect((yield* engine((workflow) => workflow.get(prAutomation.id))).automation.name).toBe(
        "Read PR",
      );

      const retryAt = cloud.alarmAt(HOOK_USER)!;
      const cronSource = `export const meta = { name: "Every minute", triggers: [{ cron: "* * * * *" }] } as const;
export default workflow(async (_w) => "ticked");`;
      remote.mockRejectedValueOnce(new Error("drive remote is temporarily unavailable"));
      yield* save(cronSource);
      const earlierAlarm = cloud.alarmAt(HOOK_USER)!;
      expect(earlierAlarm).toBeGreaterThan(failedAt);
      expect(earlierAlarm).toBeLessThan(retryAt);

      remote.mockRestore();
      vi.setSystemTime(earlierAlarm);
      yield* TestClock.setTime(earlierAlarm);
      yield* cloud.fireAlarm(HOOK_USER);
      yield* cloud.settle;
      yield* cloud.fireAlarm(HOOK_USER);
      expect(installed).toEqual([
        {
          id: 1,
          url: expect.stringContaining("/api/github/hooks/user_hooks/"),
          events: ["pull_request"],
        },
      ]);
    }),
  );
});
