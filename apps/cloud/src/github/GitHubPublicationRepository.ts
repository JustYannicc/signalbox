import * as Effect from "effect/Effect";

import type { DriveHandle } from "../drive/DriveDirectory.ts";
import type { DrivePublication } from "../drive/DrivePublicationTypes.ts";
import { DriveReadError } from "../drive/DriveReader.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubPublicationRepository } from "./GitHubApi.ts";

const markerOf = (publication: DrivePublication) => `Signalbox publication ${publication.id}`;

const validate = (publication: DrivePublication, repository: GitHubPublicationRepository) => {
  const name = `${publication.request.owner}/${publication.request.name}`;
  return (
    repository.full_name.toLowerCase() === name.toLowerCase() &&
    repository.private === (publication.request.visibility === "private") &&
    (publication.repository === null
      ? repository.description === markerOf(publication)
      : repository.id === publication.repository.id)
  );
};

export const ensurePublicationRepository = (input: {
  readonly drive: DriveHandle;
  readonly publication: DrivePublication;
  readonly token: string;
  readonly login: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const { publication } = input;
    const request = publication.request;
    const name = `${request.owner}/${request.name}`;
    const fail = (message: string) => new DriveReadError({ message });
    const read = () => github.api.publicationRepository(input.token, name);
    let existing = yield* read();
    if (publication.phase === "reserved") {
      if (existing !== null)
        return yield* fail(
          "A repository with this name already exists. Choose a new repository name.",
        );
      const started = yield* input.drive.markPublicationCreating(input.userId, publication.id);
      if (started._tag === "refused") return yield* fail(started.reason);
    }
    if (existing === null) {
      if (publication.repository !== null)
        return yield* fail(
          "The published repository is no longer available. Nothing was recreated.",
        );
      // GitHub has no creation idempotency key. Its creation marker proves ownership after a lost reply.
      existing = yield* github.api
        .createRepository(input.token, {
          owner: request.owner,
          name: request.name,
          personal: request.owner.toLowerCase() === input.login.toLowerCase(),
          private: request.visibility === "private",
          description: markerOf(publication),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(read(), (recovered) =>
              recovered === null ? Effect.fail(error) : Effect.succeed(recovered),
            ),
          ),
        );
    }
    if (existing === null || !validate(publication, existing)) {
      return yield* fail(
        "This repository does not match this publication. Nothing was bound or pushed.",
      );
    }
    const recorded = yield* input.drive.recordPublicationCreated(input.userId, {
      id: publication.id,
      repository: {
        id: existing.id,
        fullName: existing.full_name,
        webUrl: existing.html_url,
        httpsUrl: existing.clone_url,
        sshUrl: existing.ssh_url,
      },
    });
    if (recorded._tag === "refused") return yield* fail(recorded.reason);
    // The durable repository id now proves ownership, so the recovery marker can go.
    if (existing.description === markerOf(publication)) {
      yield* github.api.clearPublicationDescription(input.token, existing.full_name);
    }
    return recorded.publication;
  });
