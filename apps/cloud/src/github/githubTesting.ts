// @effect-diagnostics nodeBuiltinImport:off - the fake's git side is a real bare repository fed by git receive-pack.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHub from "./GitHub.ts";

/**
 * GitHub for tests: the App's OAuth endpoints, the REST and GraphQL calls the
 * cloud makes, and git's receive-pack, which runs against `bare`, a real
 * repository standing in for `repository` on GitHub.
 */

const FAKE_GITHUB_APP: GitHub.GitHubAppConfig = {
  clientId: "Iv1.test",
  clientSecret: "secret",
  slug: "signalbox-test",
};
const ENDPOINTS = { web: "https://github.test", api: "https://api.github.test" };

export const makeFakeGitHub = (options: {
  readonly bare: string;
  readonly repository: string;
  readonly defaultBranch: string;
}) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: ReadonlyArray<string>, input?: Uint8Array) =>
    NodeChildProcess.execFileSync("git", args, { cwd: options.bare, env, input });
  const head = (branch: string) => {
    try {
      return git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const [owner] = options.repository.split("/");
  const pulls: Array<{
    number: number;
    title: string;
    head: string;
    base: string;
    state: "open" | "closed";
    merged: boolean;
  }> = [];
  const calls: Array<string> = [];
  let refreshes = 0;
  /** Set to make GitHub turn every refresh down, as after the user revokes the App. */
  const settings = { refuseRefresh: false, refreshOutage: false };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const pullJson = (pull: (typeof pulls)[number]) => ({
    number: pull.number,
    title: pull.title,
    html_url: `${ENDPOINTS.web}/${options.repository}/pull/${pull.number}`,
    state: pull.state,
    merged_at: pull.merged ? "2026-10-08T00:00:00Z" : null,
    draft: false,
    updated_at: "2026-10-08T00:00:00Z",
    base: { ref: pull.base },
    head: { ref: pull.head },
  });

  const answer = (method: string, url: URL, body: Uint8Array): Response => {
    const path = url.pathname;
    const text = new TextDecoder().decode(body);
    if (url.origin === ENDPOINTS.web) {
      if (method === "POST" && path === "/login/oauth/access_token") {
        const params = new URLSearchParams(text);
        if (params.get("grant_type") === "refresh_token") {
          if (settings.refreshOutage) return json({ message: "Service unavailable" }, 503);
          if (settings.refuseRefresh) {
            return json({ error: "bad_refresh_token", error_description: "Revoked." });
          }
          refreshes++;
        }
        return params.get("code") === "bad"
          ? json({ error: "bad_verification_code", error_description: "The code is wrong." })
          : json({
              access_token: `ghu_${refreshes}`,
              expires_in: 28_800,
              refresh_token: `ghr_${refreshes}`,
              refresh_token_expires_in: 15_897_600,
            });
      }
      if (method === "POST" && path === `/${options.repository}.git/git-receive-pack`) {
        return new Response(git(["receive-pack", "--stateless-rpc", "."], body), {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      }
      return new Response("not found", { status: 404 });
    }
    if (method === "GET" && path === "/user") return json({ login: "octo", id: 1 });
    if (method === "GET" && path === `/repos/${options.repository}`) {
      return json({
        id: 42,
        full_name: options.repository,
        name: options.repository.split("/")[1],
        default_branch: options.defaultBranch,
        html_url: `${ENDPOINTS.web}/${options.repository}`,
        clone_url: `${ENDPOINTS.web}/${options.repository}.git`,
        ssh_url: `git@github.test:${options.repository}.git`,
      });
    }
    if (method === "POST" && path === "/graphql") {
      const oid = head(options.defaultBranch);
      return json({
        data: {
          repository: {
            defaultBranchRef:
              oid === null ? null : { name: options.defaultBranch, target: { oid } },
          },
        },
      });
    }
    const refPrefix = `/repos/${options.repository}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const oid = head(decodeURIComponent(path.slice(refPrefix.length)));
      return oid === null ? json({ message: "Not Found" }, 404) : json({ object: { sha: oid } });
    }
    if (path === `/repos/${options.repository}/pulls`) {
      if (method === "GET") {
        const wanted = url.searchParams.get("head");
        return json(
          pulls
            .filter((pull) => `${owner}:${pull.head}` === wanted)
            .toReversed()
            .map(pullJson),
        );
      }
      const input = JSON.parse(text) as { title: string; head: string; base: string };
      if (head(input.head) === null) return json({ message: "Validation Failed" }, 422);
      const pull = { ...input, number: pulls.length + 1, state: "open" as const, merged: false };
      pulls.push(pull);
      return json(pullJson(pull), 201);
    }
    if (method === "DELETE" && path.startsWith("/applications/")) {
      return new Response(null, { status: 204 });
    }
    return json({ message: "Not Found" }, 404);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      calls.push(
        `${request.method} ${url.origin === ENDPOINTS.web ? "web" : "api"}${url.pathname}`,
      );
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      return HttpClientResponse.fromWeb(request, answer(request.method, url, body));
    }),
  );

  return {
    layer: GitHub.layer(FAKE_GITHUB_APP, ENDPOINTS).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    pulls,
    calls,
    settings,
    head,
    /** Merges a pull request the way GitHub's merge button fast-forwards. */
    merge: (number: number) => {
      const pull = pulls.find((candidate) => candidate.number === number)!;
      git(["update-ref", `refs/heads/${pull.base}`, head(pull.head)!]);
      pull.state = "closed";
      pull.merged = true;
    },
  };
};
