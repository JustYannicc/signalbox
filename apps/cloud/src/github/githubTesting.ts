// @effect-diagnostics nodeBuiltinImport:off - the fake's git side is a real bare repository fed by git receive-pack.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHub from "./GitHub.ts";

/**
 * GitHub for tests: WorkOS Pipes' GitHub endpoints, the REST and GraphQL
 * calls the cloud makes, and git's receive-pack, which runs against `bare`, a
 * real repository standing in for `repository` on GitHub.
 */

const WORKOS = "https://api.workos.test";
const FAKE_PIPES = {
  apiKey: Redacted.make("sk_test"),
  apiBaseUrl: WORKOS,
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
  /** Pipes' connected accounts, by WorkOS user id, and the `return_to` of each user's last authorize. */
  const connected = new Map<string, { readonly state: "connected" | "needs_reauthorization" }>();
  const returnTo = new Map<string, string>();
  /** Set to make WorkOS fail every request, as in an outage. */
  const settings = { workosOutage: false };

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

  const pipes = (method: string, path: string, text: string): Response => {
    if (settings.workosOutage) return json({ message: "Service unavailable" }, 503);
    if (method === "POST" && path === "/data-integrations/github/authorize") {
      const input = JSON.parse(text) as { user_id: string; return_to: string };
      returnTo.set(input.user_id, input.return_to);
      return json({ url: `${WORKOS}/data-integrations/abc/authorize-redirect` });
    }
    if (method === "POST" && path === "/data-integrations/github/token") {
      const input = JSON.parse(text) as { user_id: string };
      const account = connected.get(input.user_id);
      if (account === undefined) return json({ active: false, error: "not_installed" });
      if (account.state !== "connected") return json({ active: false, error: account.state });
      return json({
        active: true,
        access_token: {
          object: "access_token",
          access_token: `gho_${input.user_id}`,
          expires_at: null,
          scopes: ["repo"],
          missing_scopes: [],
        },
      });
    }
    const deleting = /^\/user_management\/users\/([^/]+)\/connected_accounts\/github$/.exec(path);
    if (method === "DELETE" && deleting !== null) {
      const existed = connected.delete(decodeURIComponent(deleting[1]!));
      return existed ? new Response(null, { status: 204 }) : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  };

  const answer = (method: string, url: URL, body: Uint8Array): Response => {
    const path = url.pathname;
    const text = new TextDecoder().decode(body);
    if (url.origin === WORKOS) return pipes(method, path, text);
    if (url.origin === ENDPOINTS.web) {
      if (method === "POST" && path === `/${options.repository}.git/git-receive-pack`) {
        return new Response(git(["receive-pack", "--stateless-rpc", "."], body), {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      }
      return new Response("not found", { status: 404 });
    }
    if (method === "GET" && path === "/user")
      return json({ login: "octo", id: 1, name: "Octo Cat" });
    const repositoryJson = {
      id: 42,
      full_name: options.repository,
      name: options.repository.split("/")[1],
      default_branch: options.defaultBranch,
      html_url: `${ENDPOINTS.web}/${options.repository}`,
      clone_url: `${ENDPOINTS.web}/${options.repository}.git`,
      ssh_url: `git@github.test:${options.repository}.git`,
    };
    if (method === "GET" && path === "/user/repos") return json([repositoryJson]);
    if (method === "GET" && path === `/repos/${options.repository}`) return json(repositoryJson);
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
    return json({ message: "Not Found" }, 404);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const host = url.origin === WORKOS ? "workos" : url.origin === ENDPOINTS.web ? "web" : "api";
      calls.push(`${request.method} ${host}${url.pathname}`);
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      return HttpClientResponse.fromWeb(request, answer(request.method, url, body));
    }),
  );

  return {
    layer: GitHub.layer(FAKE_PIPES, ENDPOINTS).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    pulls,
    calls,
    settings,
    head,
    /** The user finishes GitHub's consent page: Pipes holds their connection, then sends them back. */
    authorize: (userId: string) => {
      connected.set(userId, { state: "connected" });
      return returnTo.get(userId) ?? null;
    },
    /** The user revokes Signalbox on GitHub; Pipes notices on the next refresh. */
    revoke: (userId: string) => connected.set(userId, { state: "needs_reauthorization" }),
    isConnected: (userId: string) => connected.has(userId),
    /** Merges a pull request the way GitHub's merge button fast-forwards. */
    merge: (number: number) => {
      const pull = pulls.find((candidate) => candidate.number === number)!;
      git(["update-ref", `refs/heads/${pull.base}`, head(pull.head)!]);
      pull.state = "closed";
      pull.merged = true;
    },
  };
};
