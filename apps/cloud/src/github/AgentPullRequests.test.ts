import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2ThreadProjection, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { PR_IMAGE_LIMIT } from "@signalbox/runner-protocol/PullRequestTools";
import type { Request } from "@signalbox/runner-protocol/PullRequestTools";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import * as Platform from "../platform.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as AgentPullRequests from "./AgentPullRequests.ts";
import * as GitHub from "./GitHub.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import { GitHubError, type GitHubApi, type GitHubPullRequest } from "./GitHubApi.ts";
import { safeApiError } from "./agentPullRequestError.ts";

const USER_ID = "user_1";
const THREAD_ID = ThreadId.make("thread-0000abcd");
const DRIVE_ID = `folder/${PERSONAL_CONTEXT_ID}/folder-a`;
const REPOSITORY = "acme/widgets";
const TOKEN = "gho_agent_pull_request_canary";
const PR_NUMBER = 42;
const BRANCH = "signalbox/0000abcd";

type AgentApi = Pick<
  GitHubApi,
  | "pullForBranch"
  | "agentPull"
  | "agentComments"
  | "agentEdit"
  | "agentComment"
  | "agentReply"
  | "agentImage"
>;

const json = (value: unknown) => JSON.stringify(value);
const pull = (headRepository = REPOSITORY, headBranch = BRANCH) =>
  json({
    number: PR_NUMBER,
    title: "Add widget support",
    body: `Provider output with ${TOKEN}`,
    state: "open",
    draft: false,
    html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}?token=${TOKEN}`,
    base: { ref: "main" },
    head: { ref: headBranch, repo: { full_name: headRepository } },
    user: { login: "octocat" },
  });
const comments = (commentId = 9001) =>
  json({
    issueComments: [],
    reviewComments: [
      {
        id: commentId,
        in_reply_to_id: null,
        body: `Please change this (${TOKEN}).`,
        path: "src/widget.ts",
        diff_hunk: "@@ -1 +1 @@",
        line: 12,
        original_line: 12,
        html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#discussion_r${commentId}`,
        created_at: "2026-10-17T10:00:00Z",
        updated_at: "2026-10-17T10:00:00Z",
        user: { login: "reviewer" },
      },
    ],
    reviews: [],
  });

const unused = () => Effect.die("not used by AgentPullRequests tests");

const makeLayer = (options: {
  readonly api?: Partial<AgentApi>;
  readonly role?: "owner" | "editor" | "viewer";
  readonly headRepository?: string;
  readonly headBranch?: string;
  readonly noBranchPullRequest?: boolean;
  readonly token?: string | null;
}) => {
  const api: AgentApi = {
    pullForBranch: () =>
      Effect.succeed<GitHubPullRequest | null>({
        number: PR_NUMBER,
        title: "Add widget support",
        url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
        state: "open",
        isDraft: false,
        updatedAt: null,
        baseRef: "main",
        headRef: BRANCH,
      }),
    agentPull: () => Effect.succeed(pull(options.headRepository, options.headBranch)),
    agentComments: () => Effect.succeed(comments()),
    agentEdit: () => Effect.succeed(json({ updated: true })),
    agentComment: () =>
      Effect.succeed(
        json({
          id: 7001,
          body: "posted",
          html_url: "https://github.com/acme/widgets/pull/42#issuecomment-7001",
          created_at: "2026-10-17T10:00:00Z",
          updated_at: "2026-10-17T10:00:00Z",
          user: { login: "octocat" },
        }),
      ),
    agentReply: () =>
      Effect.succeed(
        json({
          id: 7002,
          body: "reply",
          path: "src/widget.ts",
          html_url: "https://github.com/acme/widgets/pull/42#discussion_r7002",
          created_at: "2026-10-17T10:00:00Z",
          updated_at: "2026-10-17T10:00:00Z",
          user: { login: "octocat" },
        }),
      ),
    agentImage: () => Effect.succeed({ url: "https://github.com/user-attachments/assets/test" }),
    ...options.api,
  };

  const projection = {
    thread: {
      id: THREAD_ID,
      projectId: ProjectId.make(`drive:${DRIVE_ID}`),
      branchPullRequest: options.noBranchPullRequest
        ? null
        : {
            projectId: ProjectId.make(`drive:${DRIVE_ID}`),
            repository: REPOSITORY,
            number: PR_NUMBER,
            url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
          },
      linkedPullRequest: null,
      pullRequests: [],
    },
  } as unknown as OrchestrationV2ThreadProjection;

  const threads = CloudThreadService.CloudThreadService.of({
    threadSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projection,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: null,
      }),
    dispatchCommand: unused,
    launchThread: unused,
    threadHistoryPage: unused,
    subscribeThread: () => Stream.die("unused"),
    previews: () => Stream.die("unused"),
    browsing: () => Stream.die("unused"),
    browse: unused,
    browsingRecord: unused,
    openPreview: unused,
    browserWatch: () => Stream.die("unused"),
    browserInput: unused,
    browserTrail: unused,
    browserStep: unused,
    turnDiagnostics: unused,
    canSee: () => Effect.succeed(true),
  } as unknown as CloudThreadService.CloudThreadService["Service"]);

  const userDrives = UserDrives.UserDrives.of({
    userId: Effect.succeed(USER_ID),
    contextIds: Effect.succeed([]),
    access: () => Effect.succeed(options.role ?? "editor"),
  } as unknown as UserDrives.UserDrives["Service"]);
  const directory = DriveDirectory.of({
    forDrive: () =>
      ({
        remote: () =>
          Effect.succeed({
            provider: "github",
            repository: REPOSITORY,
            defaultBranch: "main",
          }),
      }) as never,
  });
  const connection = GitHubConnection.GitHubConnection.of({
    accessToken: Effect.succeed(options.token === undefined ? TOKEN : options.token),
  } as unknown as GitHubConnection.GitHubConnection["Service"]);
  const github = GitHub.GitHub.of({ pipes: null, api: api as never });

  return AgentPullRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Platform.layerCrypto,
        Layer.succeed(CloudThreadService.CloudThreadService, threads),
        Layer.succeed(UserDrives.UserDrives, userDrives),
        Layer.succeed(DriveDirectory, directory),
        Layer.succeed(GitHubConnection.GitHubConnection, connection),
        Layer.succeed(GitHub.GitHub, github),
      ),
    ),
  );
};

const execute = (request: Request, options: Parameters<typeof makeLayer>[0] = {}) =>
  Effect.gen(function* () {
    const service = yield* AgentPullRequests.AgentPullRequests;
    return yield* service.execute(THREAD_ID, request);
  }).pipe(Effect.provide(makeLayer(options)));

describe("cloud agent pull request operations (#861)", () => {
  it("keeps GitHub conflicts distinct from operation id reuse", () => {
    const error = safeApiError(
      new GitHubError({
        operation: "agentEdit",
        status: 422,
        message: "Validation Failed",
      }),
    );

    expect(error.category).toBe("github_conflict");
    expect(error.message).toBe("GitHub rejected this pull request change.");
  });

  it.effect("requires folder write access before it reads or writes GitHub", () =>
    Effect.gen(function* () {
      const result = yield* execute({ _tag: "read" }, { role: "viewer" }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "AgentPullRequestError",
          category: "permission",
        });
      }
    }),
  );

  it.effect("refuses a PR whose head is a fork or another branch", () =>
    Effect.gen(function* () {
      for (const options of [
        { headRepository: "attacker/widgets" },
        { headBranch: "signalbox/someone-else" },
      ]) {
        const result = yield* execute({ _tag: "read" }, options).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "AgentPullRequestError",
            category: "permission",
          });
        }
      }
    }),
  );

  it.effect("requires the caller's own GitHub connection", () =>
    Effect.gen(function* () {
      const result = yield* execute({ _tag: "read" }, { token: null }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "AgentPullRequestError",
          category: "not_connected",
        });
      }
    }),
  );

  it.effect("forwards an edit to the thread's pull request", () => {
    let received: { token: string; repository: string; number: number; body: string } | undefined;
    const body = "Updated pull request summary.";

    return Effect.gen(function* () {
      const result = yield* execute(
        { _tag: "edit", number: PR_NUMBER, body },
        {
          api: {
            agentEdit: (token, repository, number, forwardedBody) => {
              received = { token, repository, number, body: forwardedBody };
              return Effect.succeed(json({ updated: true }));
            },
          },
        },
      );

      expect(received).toEqual({ token: TOKEN, repository: REPOSITORY, number: PR_NUMBER, body });
      expect(result).toEqual({ number: PR_NUMBER, updated: true });
    });
  });

  it.effect("redacts the active token from selected PR and review output", () =>
    Effect.gen(function* () {
      const result = yield* execute({ _tag: "read" });
      const output = JSON.stringify(result);
      expect(output).not.toContain(TOKEN);
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("Please change this");
      expect(output).toContain("src/widget.ts");
    }),
  );

  it.effect("only replies to a review comment listed on this PR", () => {
    let replyCalls = 0;
    const result = execute(
      {
        _tag: "reply",
        commentId: 9002,
        body: "This comment belongs elsewhere.",
        operationId: "reply-other-pr",
      },
      {
        api: {
          agentReply: () => {
            replyCalls += 1;
            return Effect.succeed(null);
          },
        },
      },
    ).pipe(Effect.result);

    return Effect.gen(function* () {
      const failure = yield* result;
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(failure.failure).toMatchObject({ category: "permission" });
      expect(replyCalls).toBe(0);
    });
  });

  it.effect("forwards a reply to a review comment listed on this PR", () => {
    let received:
      | {
          token: string;
          repository: string;
          number: number;
          commentId: string;
          body: string;
        }
      | undefined;
    const body = "Fixed the reviewed line.";

    return Effect.gen(function* () {
      const result = yield* execute(
        { _tag: "reply", commentId: 9001, body, operationId: "reply-success" },
        {
          api: {
            agentReply: (token, repository, number, commentId, forwardedBody) => {
              received = { token, repository, number, commentId, body: forwardedBody };
              return Effect.succeed(
                json({
                  id: 7002,
                  in_reply_to_id: 9001,
                  body,
                  path: "src/widget.ts",
                  html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#discussion_r7002`,
                  created_at: "2026-10-17T10:00:00Z",
                  updated_at: "2026-10-17T10:00:00Z",
                  user: { login: "octocat" },
                }),
              );
            },
          },
        },
      );

      expect(received).toEqual({
        token: TOKEN,
        repository: REPOSITORY,
        number: PR_NUMBER,
        commentId: "9001",
        body,
      });
      expect(result).toMatchObject({
        number: PR_NUMBER,
        comment: { id: 7002, inReplyToId: 9001, body },
      });
    });
  });

  it.effect("answers a review reply through its top-level comment", () => {
    let replyTarget: string | undefined;
    return Effect.gen(function* () {
      const result = yield* execute(
        { _tag: "reply", commentId: 9002, body: "Fixed.", operationId: "nested-reply" },
        {
          api: {
            agentComments: () =>
              Effect.succeed(
                json({
                  issueComments: [],
                  reviews: [],
                  reviewComments: [{ id: 9001 }, { id: 9002, in_reply_to_id: 9001 }],
                }),
              ),
            agentReply: (_token, _repository, _number, commentId) => {
              replyTarget = commentId;
              return Effect.succeed(json({ id: 7002, in_reply_to_id: 9001, body: "Fixed." }));
            },
          },
        },
      );
      expect(replyTarget).toBe("9001");
      expect(result).toMatchObject({ comment: { id: 7002, inReplyToId: 9001 } });
    });
  });

  it.effect("forwards a checked image and returns its Markdown reference", () => {
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const url = "https://github.com/user-attachments/assets/test";
    let received:
      | {
          token: string;
          repository: string;
          name: string;
          mimeType: string;
          bytes: ReadonlyArray<number>;
        }
      | undefined;

    return Effect.gen(function* () {
      const result = yield* execute(
        {
          _tag: "image",
          name: "review.png",
          mimeType: "image/png",
          base64: Buffer.from(imageBytes).toString("base64"),
          operationId: "image-success",
        },
        {
          api: {
            agentImage: (token, repository, name, mimeType, bytes) => {
              received = { token, repository, name, mimeType, bytes: [...bytes] };
              return Effect.succeed({ url });
            },
          },
        },
      );

      expect(received).toEqual({
        token: TOKEN,
        repository: REPOSITORY,
        name: "review.png",
        mimeType: "image/png",
        bytes: [...imageBytes],
      });
      expect(result).toEqual({
        number: PR_NUMBER,
        url,
        markdown: `![review.png](${url})`,
      });
    });
  });

  it.effect("rejects image signature and size mismatches before upload", () => {
    let uploads = 0;
    const oversized = new Uint8Array(PR_IMAGE_LIMIT + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requests: ReadonlyArray<Request> = [
      {
        _tag: "image",
        name: "wrong-signature.png",
        mimeType: "image/png",
        base64: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
        operationId: "image-wrong-signature",
      },
      {
        _tag: "image",
        name: "too-large.png",
        mimeType: "image/png",
        base64: Buffer.from(oversized).toString("base64"),
        operationId: "image-too-large",
      },
    ];

    return Effect.gen(function* () {
      for (const request of requests) {
        const result = yield* execute(request, {
          api: {
            agentImage: () => {
              uploads += 1;
              return Effect.succeed(null);
            },
          },
        }).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ category: "invalid" });
      }
      expect(uploads).toBe(0);
    });
  });

  it.effect("looks up the thread branch when it has no linked pull request", () => {
    let received: { token: string; repository: string; branch: string } | undefined;

    return Effect.gen(function* () {
      const result = yield* execute(
        { _tag: "read" },
        {
          noBranchPullRequest: true,
          api: {
            pullForBranch: (token, repository, branch) => {
              received = { token, repository, branch };
              return Effect.succeed({
                number: PR_NUMBER,
                title: "Add widget support",
                url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
                state: "open",
                isDraft: false,
                updatedAt: null,
                baseRef: "main",
                headRef: BRANCH,
              });
            },
          },
        },
      );

      expect(received).toEqual({ token: TOKEN, repository: REPOSITORY, branch: BRANCH });
      expect(result).toMatchObject({ pullRequest: { number: PR_NUMBER, headBranch: BRANCH } });
    });
  });

  it.effect("allows the same operation to retry after a definite GitHub refusal", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 404, 422, 429]) {
        let calls = 0;
        const layer = makeLayer({
          api: {
            agentReply: () => {
              calls += 1;
              return calls > 1
                ? Effect.succeed(json({ id: 7002, body: "Fixed." }))
                : status === 404
                  ? Effect.succeed(null)
                  : Effect.fail(
                      new GitHubError({ operation: "reply", status, message: "Refused." }),
                    );
            },
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* AgentPullRequests.AgentPullRequests;
          const request: Request = {
            _tag: "reply",
            commentId: 9001,
            body: "Fixed.",
            operationId: `refused-${status}`,
          };
          const first = yield* service.execute(THREAD_ID, request).pipe(Effect.result);
          expect(first._tag).toBe("Failure");
          const retried = yield* service.execute(THREAD_ID, request);
          expect(retried).toMatchObject({ comment: { id: 7002 } });
          expect(calls).toBe(2);
        }).pipe(Effect.provide(layer));
      }
    }),
  );

  it.effect("does not repeat a reply after an ambiguous provider failure", () => {
    let replyCalls = 0;
    const logs: Array<string> = [];
    const layer = makeLayer({
      api: {
        agentReply: () => {
          replyCalls += 1;
          return Effect.fail(
            new GitHubError({
              operation: "reply",
              status: 0,
              message: `The response mentioning ${TOKEN} was lost.`,
            }),
          );
        },
      },
    });
    const request: Request = {
      _tag: "reply",
      commentId: 9001,
      body: "Applied the fix.",
      operationId: "reply-1",
    };

    return Effect.gen(function* () {
      const service = yield* AgentPullRequests.AgentPullRequests;
      const first = yield* service.execute(THREAD_ID, request).pipe(Effect.result);
      const second = yield* service.execute(THREAD_ID, request).pipe(Effect.result);
      expect(first._tag).toBe("Failure");
      expect(second._tag).toBe("Failure");
      if (first._tag === "Failure") expect(first.failure.message).not.toContain(TOKEN);
      if (second._tag === "Failure") expect(second.failure).toMatchObject({ category: "pending" });
      expect(replyCalls).toBe(1);
      expect(logs.join("\n")).not.toContain(TOKEN);
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))])),
    );
  });

  it.effect("replays a completed write receipt and rejects reuse with changed content", () => {
    let commentCalls = 0;
    const layer = makeLayer({
      api: {
        agentComment: () => {
          commentCalls += 1;
          return Effect.succeed(
            json({
              id: 7001,
              body: `posted ${TOKEN}`,
              html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}?token=${TOKEN}`,
              created_at: "2026-10-17T10:00:00Z",
              updated_at: "2026-10-17T10:00:00Z",
              user: { login: "octocat" },
            }),
          );
        },
      },
    });
    const request: Request = {
      _tag: "comment",
      body: "Looks good.",
      operationId: "comment-1",
    };

    return Effect.gen(function* () {
      const service = yield* AgentPullRequests.AgentPullRequests;
      const first = yield* service.execute(THREAD_ID, request);
      const duplicate = yield* service.execute(THREAD_ID, request);
      const changed = yield* service
        .execute(THREAD_ID, { ...request, body: "Different body." })
        .pipe(Effect.result);
      expect(duplicate).toEqual(first);
      expect(JSON.stringify(first)).not.toContain(TOKEN);
      expect(commentCalls).toBe(1);
      expect(changed._tag).toBe("Failure");
      if (changed._tag === "Failure") expect(changed.failure.category).toBe("conflict");
    }).pipe(Effect.provide(layer));
  });
});
