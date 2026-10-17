import type { PullRequestRef } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Environment from "../environment.ts";
import { DriveDirectory, type DriveHandle } from "../drive/DriveDirectory.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubApi } from "./GitHubApi.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserShell from "../user/UserShell.ts";

const remote = { provider: "github", repository: "Acme/Web", defaultBranch: "main" } as const;

const fixture = (options?: {
  readonly remote?: typeof remote | null;
  readonly host?: string;
  readonly token?: string | null;
}) => {
  const state = {
    canAccess: true,
    token: options?.token === undefined ? "current-token" : options.token,
    accessReads: 0,
    remoteReads: 0,
    tokenReads: 0,
    viewerReads: 0,
    lastDriveId: null as string | null,
  };
  const project = Environment.scratchProject;
  const api = {
    host: options?.host ?? "github.com",
    viewer: (token: string) =>
      Effect.sync(() => {
        expect(token).toBe(state.token);
        state.viewerReads += 1;
        return { id: 123, login: "octocat" };
      }),
  } as unknown as GitHubApi;

  const drive = {
    remote: () =>
      Effect.sync(() => {
        state.remoteReads += 1;
        return options?.remote === undefined ? remote : options.remote;
      }),
  } as unknown as DriveHandle;
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      UserShell.UserShell,
      UserShell.UserShell.of({
        snapshot: Effect.succeed(
          Environment.shellSnapshot({ sequence: 0, projects: [project], threads: [] }),
        ),
      } as unknown as UserShell.UserShell["Service"]),
    ),
    Layer.succeed(
      UserDrives.UserDrives,
      UserDrives.UserDrives.of({
        userId: Effect.succeed("user_1"),
        access: (driveId: string) =>
          Effect.sync(() => {
            state.accessReads += 1;
            state.lastDriveId = driveId;
            return state.canAccess ? ("owner" as const) : null;
          }),
      } as unknown as UserDrives.UserDrives["Service"]),
    ),
    Layer.succeed(DriveDirectory, DriveDirectory.of({ forDrive: () => drive })),
    Layer.succeed(GitHub, GitHub.of({ pipesForUser: () => Effect.succeed(null), api })),
    Layer.succeed(
      GitHubConnection.GitHubConnection,
      GitHubConnection.GitHubConnection.of({
        accessToken: Effect.sync(() => {
          state.tokenReads += 1;
          return state.token;
        }),
      } as unknown as GitHubConnection.GitHubConnection["Service"]),
    ),
  );

  return {
    layer: PullRequestRepository.layer.pipe(Layer.provide(dependencies)),
    state,
    project,
  };
};

const reference = (overrides: Partial<PullRequestRef> = {}): PullRequestRef => ({
  projectId: Environment.scratchProject.id,
  repository: "acme/web",
  number: 7,
  ...overrides,
});

it.effect(
  "resolves only the project's remote and rechecks access and token while caching its viewer",
  () => {
    const current = fixture();
    return Effect.gen(function* () {
      const repository = yield* PullRequestRepository.PullRequestRepository;
      const discovered = yield* repository.forProject(current.project.id);
      const first = yield* repository.resolve(reference({ expectedAccountId: "123" }));
      const second = yield* repository.resolve(reference({ expectedAccountId: "123" }));
      const identity = yield* repository.identity("GITHUB.COM");

      expect(first).toEqual({
        project: current.project,
        repository: "acme/web",
        host: "github.com",
        token: "current-token",
        viewer: "octocat",
        accountId: "123",
      });
      expect(discovered.repository).toBe("Acme/Web");
      expect(second.accountId).toBe("123");
      expect(identity).toEqual({
        accountId: "123",
        host: "github.com",
        provider: "github",
        viewer: "octocat",
      });
      expect(current.state.lastDriveId).toContain("user_1");
      expect(current.state.accessReads).toBe(3);
      expect(current.state.remoteReads).toBe(3);
      expect(current.state.tokenReads).toBe(4);
      expect(current.state.viewerReads).toBe(1);
      expect(yield* repository.projects).toEqual([current.project]);
    }).pipe(Effect.provide(current.layer));
  },
);

it.effect("allows another GitHub repository on the authorized host", () => {
  const current = fixture();
  return Effect.gen(function* () {
    const repository = yield* PullRequestRepository.PullRequestRepository;
    const resolved = yield* repository.resolve(
      reference({ repository: "pingdotgg/t3code", expectedAccountId: "123" }),
    );

    expect(resolved.repository).toBe("pingdotgg/t3code");
    expect(resolved.token).toBe("current-token");
    expect(resolved.accountId).toBe("123");
    expect(current.state.accessReads).toBe(1);
    expect(current.state.remoteReads).toBe(1);
    expect(current.state.tokenReads).toBe(1);
    expect(current.state.viewerReads).toBe(1);
  }).pipe(Effect.provide(current.layer));
});

it.effect("rejects wrong-host and malformed pull request repositories", () => {
  const current = fixture();
  return Effect.gen(function* () {
    const repository = yield* PullRequestRepository.PullRequestRepository;
    const wrongHost = yield* Effect.flip(
      repository.resolve(reference({ repository: "pingdotgg/t3code", host: "gitlab.com" })),
    );
    const malformed = yield* Effect.flip(
      repository.resolve(reference({ repository: "not a repo" })),
    );
    expect(wrongHost._tag).toBe("PullRequestOperationError");
    expect(malformed._tag).toBe("PullRequestOperationError");
    expect(current.state.accessReads).toBe(2);
    expect(current.state.remoteReads).toBe(2);
    expect(current.state.tokenReads).toBe(0);
    expect(current.state.viewerReads).toBe(0);

    const wrongAccount = yield* Effect.flip(
      repository.resolve(reference({ expectedAccountId: "999" })),
    );
    expect(wrongAccount._tag).toBe("PullRequestOperationError");
    expect(current.state.tokenReads).toBe(1);
    expect(current.state.viewerReads).toBe(1);
  }).pipe(Effect.provide(current.layer));
});

it.effect("rejects removed drive access and a routing identity for another host", () => {
  const current = fixture();
  return Effect.gen(function* () {
    const repository = yield* PullRequestRepository.PullRequestRepository;
    yield* repository.resolve(reference());
    current.state.canAccess = false;
    const denied = yield* Effect.flip(
      repository.resolve(reference({ repository: "pingdotgg/t3code" })),
    );
    const wrongHost = yield* Effect.flip(repository.identity("git.example.com"));

    expect(denied._tag).toBe("PullRequestOperationError");
    expect(wrongHost._tag).toBe("PullRequestUnavailableError");
    expect(current.state.accessReads).toBe(2);
    expect(current.state.remoteReads).toBe(1);
    expect(current.state.tokenReads).toBe(1);
  }).pipe(Effect.provide(current.layer));
});

it.effect("lets listing skip projects with no GitHub remote but reports revoked access", () => {
  const empty = fixture({ remote: null });
  const denied = fixture();
  denied.state.canAccess = false;
  return Effect.gen(function* () {
    const emptyRepository = yield* PullRequestRepository.PullRequestRepository.pipe(
      Effect.provide(empty.layer),
    );
    const missingRemote = yield* Effect.flip(emptyRepository.forProject(empty.project.id));
    expect(missingRemote._tag).toBe("PullRequestUnavailableError");

    const deniedRepository = yield* PullRequestRepository.PullRequestRepository.pipe(
      Effect.provide(denied.layer),
    );
    const inaccessible = yield* Effect.flip(deniedRepository.forProject(denied.project.id));
    expect(inaccessible._tag).toBe("PullRequestOperationError");
  });
});

it.effect("reports a missing GitHub connection as unavailable", () => {
  const current = fixture({ token: null });
  return Effect.gen(function* () {
    const repository = yield* PullRequestRepository.PullRequestRepository;
    const error = yield* Effect.flip(repository.resolve(reference()));

    expect(error._tag).toBe("PullRequestUnavailableError");
    if (error._tag === "PullRequestUnavailableError")
      expect(error.reason).toBe("cli-unauthenticated");
    expect(current.state.viewerReads).toBe(0);
  }).pipe(Effect.provide(current.layer));
});
