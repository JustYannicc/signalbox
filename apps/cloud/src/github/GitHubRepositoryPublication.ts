import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import { canManageDrive, type SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { DriveReadError } from "../drive/DriveReader.ts";
import { PushRefused } from "../drive/gitPush.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import { parseDriveId } from "../drive/driveAccess.ts";
import type { DrivePublication } from "../drive/DrivePublicationTypes.ts";
import type { Actor } from "../thread/ThreadAccess.ts";
import { driveOfRoot } from "../user/contextProjects.ts";
import { publicationIdentity } from "./GitHubPublicationIdentity.ts";
import { ensurePublicationRepository } from "./GitHubPublicationRepository.ts";
import { planPublicationPush, pushPublication } from "./GitHubPublicationPush.ts";

const GITHUB = SourceControlProviderKind.make("github");
const failed = (detail: string) =>
  new SourceControlRepositoryError({ provider: GITHUB, operation: "publishRepository", detail });

const resultOf = (publication: DrivePublication): SourceControlPublishRepositoryResult => {
  const repository = publication.repository!;
  return {
    repository: {
      provider: GITHUB,
      nameWithOwner: repository.fullName,
      url: repository.httpsUrl,
      sshUrl: repository.sshUrl,
    },
    remoteName: publication.request.remoteName,
    remoteUrl: publication.request.protocol === "ssh" ? repository.sshUrl : repository.httpsUrl,
    branch: publication.request.branch,
    ...(publication.head === null
      ? {}
      : { upstreamBranch: `${publication.request.remoteName}/${publication.request.branch}` }),
    status: publication.head === null ? "remote_added" : "pushed",
  };
};

export const makeRepositoryPublication = (
  accessDrive: (driveId: string) => Effect.Effect<SignalboxDriveRole | null, unknown>,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const packs = yield* Effect.serviceOption(DrivePacks);
    const crypto = yield* Crypto.Crypto;
    const identityContext = yield* Effect.context<Effect.Services<typeof publicationIdentity>>();
    const githubContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof ensurePublicationRepository>>>();

    return (actor: Actor, input: SourceControlPublishRepositoryInput) =>
      Effect.gen(function* () {
        if (input.provider !== GITHUB)
          return yield* failed("Only GitHub repositories can be published from this cloud.");
        if ((input.remoteName ?? "origin") !== "origin")
          return yield* failed("Cloud folders use the origin remote.");
        const driveId = driveOfRoot(input.cwd, actor.userId);
        const parsed = driveId === null ? null : parseDriveId(driveId);
        if (
          driveId === null ||
          parsed === null ||
          parsed.kind === "my" ||
          directory._tag === "None" ||
          packs._tag === "None"
        ) {
          return yield* failed("Choose a folder with its own files to publish.");
        }
        if (!canManageDrive(yield* accessDrive(driveId)))
          return yield* failed("Only a folder manager can publish its repository.");
        const pieces = input.repository.trim().split("/");
        if (
          pieces.length !== 2 ||
          !pieces.every((part) => /^[a-z0-9_.-]+$/i.test(part) && part !== "." && part !== "..")
        ) {
          return yield* failed(
            "Enter the GitHub owner and repository name, like owner/repository.",
          );
        }
        const identity = yield* publicationIdentity.pipe(Effect.provideContext(identityContext));
        const drive = directory.value.forDrive(driveId);
        const begun = yield* drive.beginPublication(actor.userId, {
          operationId: yield* crypto.randomUUIDv4(),
          githubAccountId: identity.id,
          githubAccountLogin: identity.login,
          owner: pieces[0]!,
          name: pieces[1]!,
          visibility: input.visibility,
          remoteName: "origin",
          protocol: input.protocol === "ssh" ? "ssh" : "https",
          branch: "main",
        });
        if (begun._tag === "refused") return yield* failed(begun.reason);
        let publication = begun.publication;
        const plan = (head: string | null) =>
          planPublicationPush(driveId, head).pipe(
            Effect.provideService(DriveDirectory, directory.value),
            Effect.provideService(DrivePacks, packs.value),
          );
        if (publication.phase === "reserved") yield* plan(yield* drive.ref(MAIN_REF));
        publication = yield* ensurePublicationRepository({
          drive,
          publication,
          token: identity.token,
          login: identity.login,
          userId: actor.userId,
        }).pipe(Effect.provideContext(githubContext));
        if (publication.phase === "created") {
          const main = yield* drive.ref(MAIN_REF);
          yield* plan(main);
          const bound = yield* drive.bindPublication(actor.userId, {
            id: publication.id,
            expectedMain: main,
          });
          if (bound._tag === "refused") return yield* failed(bound.reason);
          publication = bound.publication;
        }
        if (publication.phase === "bound") {
          const packed = yield* plan(publication.head);
          if (packed !== null && publication.head !== null) {
            yield* pushPublication({
              token: identity.token,
              repository: publication.repository!.fullName,
              branch: publication.request.branch,
              head: publication.head,
              packed,
            }).pipe(Effect.provideContext(githubContext));
          }
          const finished = yield* drive.finishPublication(actor.userId, publication.id);
          if (finished._tag === "refused") return yield* failed(finished.reason);
          publication = finished.publication;
        }
        return resultOf(publication);
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof SourceControlRepositoryError) return Effect.fail(error);
          if (error instanceof DriveReadError || error instanceof PushRefused)
            return Effect.fail(failed(error.message));
          return Effect.logWarning("Cloud folder publication failed", { error }).pipe(
            Effect.andThen(
              Effect.fail(failed("The folder could not be published. Retry to continue.")),
            ),
          );
        }),
      );
  });
