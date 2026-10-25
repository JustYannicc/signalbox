import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestRef,
  type PullRequestRoutingIdentityResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserShell from "../user/UserShell.ts";
import { GitHub } from "./GitHub.ts";
import { parseRepository } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

export interface ResolvedPullRequestRepository {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
  readonly host: string;
  readonly token: string;
  readonly viewer: string;
  readonly accountId: string;
}

interface AuthorizedProject {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
  readonly host: string;
}

type RepositoryError = PullRequestUnavailableError | PullRequestOperationError;

/** Resolves a pull request only through a project and GitHub drive the user can open now. */
export class PullRequestRepository extends Context.Service<
  PullRequestRepository,
  {
    readonly projects: Effect.Effect<
      ReadonlyArray<OrchestrationProjectShell>,
      PullRequestOperationError
    >;
    readonly forProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ResolvedPullRequestRepository, RepositoryError>;
    readonly resolve: (
      ref: PullRequestRef,
    ) => Effect.Effect<ResolvedPullRequestRepository, RepositoryError>;
    readonly identity: (
      host: string,
    ) => Effect.Effect<PullRequestRoutingIdentityResult, RepositoryError>;
  }
>()("@signalbox/cloud/github/PullRequestRepository") {}

const unsupported = () => new PullRequestUnavailableError({ reason: "provider-unsupported" });
const unsupportedProvider = (provider: SourceControlProviderKind) =>
  new PullRequestUnavailableError({ reason: "provider-unsupported", provider });
const noConnection = () =>
  new PullRequestUnavailableError({
    reason: "cli-unauthenticated",
    provider: SourceControlProviderKind.make("github"),
  });

const MAX_CACHED_VIEWERS = 32;

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const drives = yield* UserDrives.UserDrives;
  const shell = yield* UserShell.UserShell;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  // Viewer identity is stable for a token. Tokens themselves and authorization are always read anew.
  const viewers = yield* Ref.make(
    new Map<string, { readonly accountId: string; readonly viewer: string }>(),
  );

  const projects: PullRequestRepository["Service"]["projects"] = shell.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects),
    Effect.mapError(
      (cause) =>
        new PullRequestOperationError({
          operation: "listProjects",
          detail: "Could not read the authorized projects.",
          cause,
        }),
    ),
  );

  const tokenForCurrentConnection = Effect.gen(function* () {
    const token = yield* connection.accessToken.pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "routeIdentity",
            detail: "Could not verify the GitHub account.",
            cause,
          }),
      ),
    );
    return token === null ? yield* noConnection() : token;
  });

  const viewerForToken = (token: string) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(viewers)).get(token);
      if (cached !== undefined) return cached;

      const viewer = yield* github.api.viewer(token).pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "routeIdentity",
              detail: "Could not verify the GitHub account.",
              cause,
            }),
        ),
      );
      if (viewer === null)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "Could not verify the GitHub account.",
        });

      const identity = { accountId: String(viewer.id), viewer: viewer.login };
      yield* Ref.update(viewers, (current) => {
        const next = new Map(current);
        // Refresh insertion order so frequently used credentials stay in the bounded cache.
        next.delete(token);
        next.set(token, identity);
        if (next.size > MAX_CACHED_VIEWERS) next.delete(next.keys().next().value!);
        return next;
      });
      return identity;
    });

  const authorizeProject = (
    projectId: ProjectId,
  ): Effect.Effect<AuthorizedProject, RepositoryError> =>
    Effect.gen(function* () {
      const shellSnapshot = yield* shell.snapshot.pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "routeIdentity",
              detail: "Could not read the authorized projects.",
              cause,
            }),
        ),
      );
      const project = shellSnapshot.projects.find((entry) => entry.id === projectId);
      if (project === undefined)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "The project is no longer available.",
        });

      const userId = yield* drives.userId.pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "routeIdentity",
              detail: "Could not verify project access.",
              cause,
            }),
        ),
      );
      if (userId === null)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "Could not verify project access.",
        });
      const driveId = driveOfProject(projectId, userId);
      if (driveId === null)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "Could not verify project access.",
        });
      if (directory._tag === "None")
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "Could not read the project's repository.",
        });

      const role = yield* drives.access(driveId).pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "routeIdentity",
              detail: "Could not verify project access.",
              cause,
            }),
        ),
      );
      if (role === null)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "Could not verify project access.",
        });

      const remote = yield* directory.value
        .forDrive(driveId)
        .remote()
        .pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestOperationError({
                operation: "routeIdentity",
                detail: "Could not read the authorized project's repository.",
                cause,
              }),
          ),
        );
      if (remote === null) return yield* unsupported();
      const provider: string = remote.provider;
      if (provider !== "github")
        return yield* unsupportedProvider(SourceControlProviderKind.make(provider));
      return { project, repository: remote.repository, host: github.api.host };
    });

  const resolveCredential = (authorized: AuthorizedProject) =>
    Effect.gen(function* () {
      const token = yield* tokenForCurrentConnection;
      const resolved = yield* viewerForToken(token);
      return { ...authorized, token, ...resolved };
    });

  const forProject: PullRequestRepository["Service"]["forProject"] = (projectId) =>
    authorizeProject(projectId).pipe(
      Effect.flatMap(resolveCredential),
      Effect.withSpan("PullRequestRepository.forProject", {
        attributes: { "project.id": projectId },
      }),
    );

  const identity: PullRequestRepository["Service"]["identity"] = (requestedHost) =>
    Effect.gen(function* () {
      const host = requestedHost.trim().toLowerCase();
      if (host !== github.api.host) return yield* unsupported();
      const token = yield* tokenForCurrentConnection;
      const resolved = yield* viewerForToken(token);
      return {
        ...resolved,
        host,
        provider: "github" as const,
      };
    }).pipe(Effect.withSpan("PullRequestRepository.identity"));

  const resolve: PullRequestRepository["Service"]["resolve"] = (ref) =>
    Effect.gen(function* () {
      const authorized = yield* authorizeProject(ref.projectId);
      if (ref.host !== undefined && ref.host.toLowerCase() !== authorized.host)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "The GitHub repository could not be verified.",
        });
      const repository = parseRepository(ref.repository);
      if (repository === null)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "The GitHub repository could not be verified.",
        });

      const resolved = yield* resolveCredential(authorized);
      if (ref.expectedAccountId !== undefined && ref.expectedAccountId !== resolved.accountId)
        return yield* new PullRequestOperationError({
          operation: "routeIdentity",
          detail: "The GitHub account could not be verified.",
        });

      return { ...resolved, repository };
    }).pipe(
      Effect.withSpan("PullRequestRepository.resolve", {
        attributes: { "project.id": ref.projectId },
      }),
    );

  return PullRequestRepository.of({ projects, forProject, resolve, identity });
});

export const layer = Layer.effect(PullRequestRepository, make);
