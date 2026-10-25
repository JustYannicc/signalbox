import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Platform from "../platform.ts";
import { makeMemoryDrives } from "../drive/driveTesting.ts";
import { layerMemoryStore } from "../testing.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserDriveIndex from "../user/UserDriveIndex.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserStore from "../user/UserStore.ts";
import { projectIdForDrive } from "../user/contextProjects.ts";
import * as GitHubActions from "./GitHubActions.ts";
import * as GitHub from "./GitHub.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import { makeGitHubApi, type GitHubApi } from "./GitHubApi.ts";
import {
  makeGitHubOperationJournal,
  type GitHubOperationJournal,
} from "./githubOperationJournal.ts";
import { makeWorkflowApi } from "./workflowApi.ts";

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

const endpoints = { web: "https://github.com", api: "https://api.github.test" };
const sha = "a".repeat(40);
const correlationId = "proof:codex:1.2.3";

const requestInput = {
  workflowFile: "harness-release-proof.yml",
  ref: "main",
  headSha: sha,
  correlationId,
  inputs: { provider: "codex", version: "1.2.3", runKey: correlationId },
} as const;

const workflowAttempt = (projectId: string) => ({
  projectId,
  repository: "acme/app",
  workflowFile: ".github/workflows/harness-release-proof.yml",
  correlationId,
  headSha: sha,
  request: { ref: "main", headSha: sha, inputs: requestInput.inputs },
});

const runBody = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  html_url: "https://github.com/acme/app/actions/runs/42",
  path: ".github/workflows/harness-release-proof.yml@refs/heads/main",
  head_sha: sha,
  display_title: correlationId,
  status: "queued",
  conclusion: null,
  event: "workflow_dispatch",
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fixture = (respond: (request: SentRequest) => Response) => {
  const requests: Array<SentRequest> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      const sent = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
      };
      requests.push(sent);
      return HttpClientResponse.fromWeb(request, respond(sent));
    }),
  );
  return {
    requests,
    api: makeGitHubApi(client, endpoints),
  };
};

const dependencies = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Platform.layerCrypto,
);

const workflowFor = (api: GitHubApi, journal: GitHubOperationJournal) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return makeWorkflowApi(api, journal, crypto);
  });

const USER = "user_1";
const REPOSITORY_DRIVE = "folder/personal/actions";
const REPOSITORY_PROJECT = projectIdForDrive(REPOSITORY_DRIVE);
const repositoryOwner = { userId: "repo_owner", email: "owner@example.test", name: "Owner" };
const user = { userId: USER, email: "user@example.test", name: "User" };

const fakePipes: GitHub.GitHubPipes = {
  authorizeUrl: () => Effect.succeed("https://github.test/connect"),
  accessToken: () =>
    Effect.succeed({
      _tag: "active",
      token: Redacted.make("github-test-token"),
      expiresAt: null,
      missingScopes: [],
    }),
  disconnect: () => Effect.void,
};

const gitHubActionsLayer = (api: GitHubApi, drives: ReturnType<typeof makeMemoryDrives>) =>
  GitHubActions.layer.pipe(
    Layer.provideMerge(UserDrives.layer),
    Layer.provideMerge(GitHubConnection.layer),
    Layer.provideMerge(layerMemoryStore),
    Layer.provideMerge(
      Layer.succeed(
        GitHub.GitHub,
        GitHub.GitHub.of({ pipesForUser: () => Effect.succeed(fakePipes), api }),
      ),
    ),
    Layer.provideMerge(drives.layer),
  );

const prepareRepositoryFolder = (drives: ReturnType<typeof makeMemoryDrives>, shareUser: boolean) =>
  Effect.gen(function* () {
    const store = yield* UserStore.UserStore;
    const folders = yield* UserFolders.UserFolders;
    const driveIndex = yield* UserDriveIndex.UserDriveIndex;
    const connection = yield* GitHubConnection.GitHubConnection;
    yield* store.recordSignIn({ id: USER, email: user.email });
    yield* connection.adopt({ login: "octo", githubUserId: 42 });

    const drive = drives.apiFor(REPOSITORY_DRIVE);
    yield* Effect.promise(() =>
      drive.setup({ name: "acme/app", members: [{ ...repositoryOwner, role: "owner" }] }),
    );
    yield* Effect.promise(() =>
      drive.setRemote({ provider: "github", repository: "acme/app", defaultBranch: "main" }),
    );
    if (shareUser) yield* Effect.promise(() => drive.share(repositoryOwner, user, "editor"));

    yield* driveIndex.record({
      driveId: REPOSITORY_DRIVE,
      name: "acme/app",
      role: "editor",
      sharedBy: repositoryOwner.userId,
      revision: 1,
    });
    const snapshot = yield* folders.snapshot;
    const folder = snapshot.folders.find((entry) => entry.files?.projectId === REPOSITORY_PROJECT);
    if (folder === undefined) throw new Error("The repository drive didn't create its folder.");
    return { drive, folder, folders };
  });

it.effect("dispatches once, validates the actual run, and replays from the durable result", () => {
  let visible = false;
  let dispatches = 0;
  const { api, requests } = fixture(({ method, path, body }) => {
    if (method === "GET" && path.includes("/actions/workflows/"))
      return json({ workflow_runs: visible ? [runBody()] : [] });
    if (method === "POST" && path.endsWith("/dispatches")) {
      dispatches += 1;
      expect(body).toEqual({
        ref: "main",
        inputs: requestInput.inputs,
        return_run_details: true,
      });
      visible = true;
      return json({ workflow_run_id: 42, html_url: runBody().html_url });
    }
    if (method === "GET" && path.endsWith("/actions/runs/42"))
      return visible ? json(runBody()) : json({ message: "Not Found" }, 404);
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const first = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const accepted = yield* first.workflowDispatch("token", "acme/app", "project-1", requestInput);
    const restarted = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const replay = yield* restarted.workflowDispatch("token", "acme/app", "project-1", {
      ...requestInput,
      inputs: { runKey: correlationId, version: "1.2.3", provider: "codex" },
    });

    expect(accepted).toMatchObject({
      runId: "42",
      workflowFile: ".github/workflows/harness-release-proof.yml",
      headSha: sha,
      displayTitle: correlationId,
    });
    expect(replay).toEqual(accepted);
    expect(dispatches).toBe(1);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "GET"]);
  }).pipe(Effect.provide(dependencies));
});

it.effect("keeps an unknown dispatch pending across journal reconstruction", () => {
  let dispatches = 0;
  const { api, requests } = fixture(({ method, path }) => {
    if (method === "GET" && path.includes("/actions/workflows/"))
      return json({ workflow_runs: [] });
    if (method === "POST" && path.endsWith("/dispatches")) {
      dispatches += 1;
      return json({ message: "response lost after submission" }, 502);
    }
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const first = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const firstError = yield* Effect.flip(
      first.workflowDispatch("token", "acme/app", "project-1", requestInput),
    );
    const restarted = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const retryError = yield* Effect.flip(
      restarted.workflowDispatch("token", "acme/app", "project-1", requestInput),
    );

    expect(firstError.message).toContain("durable attempt stays pending");
    expect(retryError.message).toContain("will not dispatch this correlation ID again");
    expect(dispatches).toBe(1);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  }).pipe(Effect.provide(dependencies));
});

it.effect("reads every workflow run page before deciding whether to dispatch", () => {
  const oldRuns = Array.from({ length: 100 }, (_, id) =>
    runBody({ id: id + 1, display_title: "older run " + id }),
  );
  const { api, requests } = fixture(({ method, path, query }) => {
    if (method === "GET" && path.includes("/actions/workflows/"))
      return json({
        workflow_runs: query.get("page") === "1" ? oldRuns : [runBody()],
      });
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(runBody());
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const run = yield* workflow.workflowDispatch("token", "acme/app", "project-1", requestInput);
    const pages = requests
      .filter((request) => request.path.includes("/actions/workflows/"))
      .map((request) => request.query.get("page"));

    expect(run.runId).toBe("42");
    expect(pages).toEqual(["1", "2"]);
    expect(requests.some(({ method }) => method === "POST")).toBe(false);
  }).pipe(Effect.provide(dependencies));
});

it.effect("refuses new and pending dispatches when GitHub caps the filtered run search", () => {
  const { api, requests } = fixture(({ method, path, query }) => {
    if (method === "GET" && path.includes("/actions/workflows/"))
      return json({
        total_count: 2_500,
        workflow_runs: Array.from({ length: 100 }, (_, index) =>
          runBody({
            id: Number(query.get("page")) * 100 + index,
            display_title: "an unrelated run",
          }),
        ),
      });
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const journal = yield* makeGitHubOperationJournal;
    const workflow = yield* workflowFor(api, journal);
    const first = yield* Effect.flip(
      workflow.workflowDispatch("token", "acme/app", "new-project", requestInput),
    );
    expect(first.message).toContain("1,000-result limit");
    expect((yield* journal.claimWorkflow(workflowAttempt("new-project")))._tag).toBe("claimed");

    expect((yield* journal.claimWorkflow(workflowAttempt("pending-project")))._tag).toBe("claimed");
    const retry = yield* Effect.flip(
      workflow.workflowDispatch("token", "acme/app", "pending-project", requestInput),
    );
    expect(retry.message).toContain("1,000-result limit");
    expect((yield* journal.claimWorkflow(workflowAttempt("pending-project")))._tag).toBe("pending");

    const searches = requests.filter((request) => request.path.includes("/actions/workflows/"));
    expect(searches).toHaveLength(20);
    expect(searches.some(({ method }) => method === "POST")).toBe(false);
    expect(searches.map(({ query }) => query.get("page"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
  }).pipe(Effect.provide(dependencies));
});

it.effect("refuses workflow dispatches and issue writes without the folder's GitHub lend", () => {
  const { api, requests } = fixture(() => {
    throw new Error("A write without the folder's lend must not reach GitHub.");
  });
  const drives = makeMemoryDrives();

  return Effect.gen(function* () {
    yield* prepareRepositoryFolder(drives, true);
    const actions = yield* GitHubActions.GitHubActions;
    const dispatch = yield* Effect.flip(actions.workflowDispatch(REPOSITORY_PROJECT, requestInput));
    const issue = yield* Effect.flip(
      actions.createIssue(REPOSITORY_PROJECT, {
        title: "Proof issue",
        body: "Please review this run.",
        correlationId: "issue:proof:1",
      }),
    );

    expect(dispatch.message).toContain("No GitHub is lent to this folder's CI steps.");
    expect(issue.message).toContain("No GitHub is lent to this folder's CI steps.");
    expect(requests).toHaveLength(0);
  }).pipe(Effect.provide(gitHubActionsLayer(api, drives)));
});

it.effect("requires trusted folder-drive access but reads a run after its GitHub lend ends", () => {
  let failRead = false;
  const { api, requests } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42"))
      return failRead ? json({ message: "private GitHub response details" }, 500) : json(runBody());
    throw new Error("Unexpected " + method + " " + path);
  });
  const drives = makeMemoryDrives();

  return Effect.gen(function* () {
    const { drive, folder, folders } = yield* prepareRepositoryFolder(drives, false);
    const actions = yield* GitHubActions.GitHubActions;
    const noDriveAccess = yield* Effect.flip(
      actions.workflowRead(REPOSITORY_PROJECT, {
        workflowFile: requestInput.workflowFile,
        runId: "42",
        headSha: sha,
      }),
    );
    expect(noDriveAccess.message).toContain("This folder doesn't come from a GitHub repository.");

    yield* Effect.promise(() => drive.share(repositoryOwner, user, "editor"));
    yield* folders.setGitHubLend(folder.id, "octo");
    yield* folders.setGitHubLend(folder.id, null);

    const run = yield* actions.workflowRead(REPOSITORY_PROJECT, {
      workflowFile: requestInput.workflowFile,
      runId: "42",
      headSha: sha,
    });
    expect(run).toMatchObject({ runId: "42", headSha: sha });

    failRead = true;
    const readError = yield* Effect.flip(
      actions.workflowRead(REPOSITORY_PROJECT, {
        workflowFile: requestInput.workflowFile,
        runId: "42",
        headSha: sha,
      }),
    );
    expect(readError.message).toBe("Couldn't read the GitHub Actions run.");
    expect(readError.message).not.toContain("private GitHub response details");
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  }).pipe(Effect.provide(gitHubActionsLayer(api, drives)));
});

it.effect("rejects a workflow run whose head or workflow path differs", () => {
  const current = runBody();
  const { api } = fixture(({ method, path, query }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42"))
      return json(
        query.get("wrong") === "path"
          ? { ...current, path: ".github/workflows/other.yml" }
          : current,
      );
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const wrongHead = yield* Effect.flip(
      workflow.workflowRead("token", "acme/app", {
        workflowFile: requestInput.workflowFile,
        runId: "42",
        headSha: "b".repeat(40),
      }),
    );
    expect(wrongHead.message).toContain("doesn't match");
    const wrongPath = yield* Effect.flip(
      workflow.workflowRead("token", "acme/app", {
        workflowFile: "other.yml",
        runId: "42",
        headSha: sha,
      }),
    );
    expect(wrongPath.message).toContain("doesn't match");
  }).pipe(Effect.provide(dependencies));
});

it.effect("recovers an issue after a lost create response and dedupes by its exact marker", () => {
  const humanBody = "Please review the run.";
  const correlation = "issue:proof:1";
  let created: { number: number; title: string; html_url: string; body: string } | null = null;
  let posts = 0;
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: "Other issue",
    html_url: "https://github.com/acme/app/issues/" + (index + 1),
    body: "unrelated",
  }));
  const { api, requests } = fixture(({ method, path, query, body }) => {
    if (method === "GET" && path.endsWith("/issues"))
      return json(query.get("page") === "1" ? fullPage : created === null ? [] : [created]);
    if (method === "POST" && path.endsWith("/issues")) {
      posts += 1;
      const input = body as { readonly title: string; readonly body: string };
      created = {
        number: 101,
        title: input.title,
        html_url: "https://github.com/acme/app/issues/101",
        body: input.body,
      };
      return json({ message: "response lost after issue creation" }, 502);
    }
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const input = { title: "Review proof", body: humanBody, correlationId: correlation };
    const first = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const issue = yield* first.createIssue("token", "acme/app", "project-1", input);
    const restarted = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const replay = yield* restarted.createIssue("token", "acme/app", "project-1", input);
    const post = requests.find((request) => request.method === "POST");
    const marker = "<!-- signalbox:github-issue:v1:project-1:issue%3Aproof%3A1 -->";

    expect(issue).toEqual({
      number: 101,
      title: "Review proof",
      url: "https://github.com/acme/app/issues/101",
    });
    expect(replay).toEqual(issue);
    expect(created?.body).toBe(humanBody + "\n\n" + marker);
    expect(post?.body).toMatchObject({ body: expect.stringContaining(marker) });
    expect(posts).toBe(1);
    expect(
      requests.filter((request) => request.method === "GET").map(({ query }) => query.get("page")),
    ).toEqual(["1", "2", "1", "2"]);
  }).pipe(Effect.provide(dependencies));
});

it.effect("refuses duplicate issue markers and never submits a second uncertain create", () => {
  let posts = 0;
  let duplicate = true;
  const marker = "<!-- signalbox:github-issue:v1:project-1:issue%3Aduplicate -->";
  const exactIssue = (number: number) => ({
    number,
    title: "Existing",
    html_url: "https://github.com/acme/app/issues/" + number,
    body: marker,
  });
  const { api, requests } = fixture(({ method, path, body }) => {
    if (method === "GET" && path.endsWith("/issues"))
      return json(duplicate ? [exactIssue(1), exactIssue(2)] : []);
    if (method === "POST" && path.endsWith("/issues")) {
      posts += 1;
      return json({ message: "unknown create outcome" }, 502);
    }
    throw new Error("Unexpected " + method + " " + path + " " + String(body));
  });

  return Effect.gen(function* () {
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const duplicateError = yield* Effect.flip(
      workflow.createIssue("token", "acme/app", "project-1", {
        title: "Duplicate marker",
        body: "",
        correlationId: "issue:duplicate",
      }),
    );
    expect(duplicateError.message).toContain("More than one GitHub issue");
    expect(posts).toBe(0);

    duplicate = false;
    const firstError = yield* Effect.flip(
      workflow.createIssue("token", "acme/app", "project-1", {
        title: "Unknown outcome",
        body: "",
        correlationId: "issue:unknown",
      }),
    );
    const restarted = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const retryError = yield* Effect.flip(
      restarted.createIssue("token", "acme/app", "project-1", {
        title: "Unknown outcome",
        body: "",
        correlationId: "issue:unknown",
      }),
    );

    expect(firstError.message).toContain("durable attempt stays pending");
    expect(retryError.message).toContain("will not create this correlation ID again");
    expect(posts).toBe(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  }).pipe(Effect.provide(dependencies));
});
