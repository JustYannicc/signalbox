import * as Schema from "effect/Schema";

export const DrivePublicationRequest = Schema.Struct({
  operationId: Schema.String.check(Schema.isUUID()),
  githubAccountId: Schema.Number,
  githubAccountLogin: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  visibility: Schema.Literals(["public", "private"]),
  remoteName: Schema.String,
  protocol: Schema.Literals(["https", "ssh"]),
  branch: Schema.Literal("main"),
});
export type DrivePublicationRequest = typeof DrivePublicationRequest.Type;

export const DrivePublicationRepository = Schema.Struct({
  id: Schema.Number,
  fullName: Schema.String,
  webUrl: Schema.String,
  httpsUrl: Schema.String,
  sshUrl: Schema.String,
});
export type DrivePublicationRepository = typeof DrivePublicationRepository.Type;

export const DrivePublication = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  userId: Schema.String,
  request: DrivePublicationRequest,
  phase: Schema.Literals(["reserved", "creating", "created", "bound", "complete"]),
  repository: Schema.NullOr(DrivePublicationRepository),
  // Phase distinguishes an unbound receipt from a bound empty history.
  head: Schema.NullOr(Schema.String),
});
export type DrivePublication = typeof DrivePublication.Type;

export type DrivePublicationResult =
  | { readonly _tag: "ok"; readonly publication: DrivePublication }
  | { readonly _tag: "refused"; readonly reason: string };

export interface RecordPublicationCreatedRequest {
  readonly id: string;
  readonly repository: DrivePublicationRepository;
}

export interface BindPublicationRequest {
  readonly id: string;
  readonly expectedMain: string | null;
}
