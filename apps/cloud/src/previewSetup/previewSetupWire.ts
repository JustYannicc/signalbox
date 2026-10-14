import * as Schema from "effect/Schema";

import { FolderRows, SectionRows } from "../user/folderRows.ts";

/**
 * What crosses between a preview and production when a preview takes a
 * user's setup (`PreviewSetup.ts`): the routes, the redeem request and the
 * setup itself. The setup is everything someone set up once and nothing they
 * did since: no threads, sessions, grants, drives or running work.
 */

export const PREVIEW_SETUP_START_PATH = "/api/preview-setup/start";
export const PREVIEW_SETUP_AUTHORIZE_PATH = "/api/preview-setup/authorize";
export const PREVIEW_SETUP_CALLBACK_PATH = "/api/preview-setup/callback";
export const PREVIEW_SETUP_REDEEM_PATH = "/api/preview-setup/redeem";

/** A preview asking production for the setup its signed-in user's claim names. */
export const PreviewSetupRedeemRequest = Schema.Struct({
  code: Schema.String,
  verifier: Schema.String,
  /** The preview's origin, which the claim must be bound to. */
  origin: Schema.String,
  /** The preview's signed-in user, who the claim must name. */
  userId: Schema.String,
});
export type PreviewSetupRedeemRequest = typeof PreviewSetupRedeemRequest.Type;

export const PreviewSetup = Schema.Struct({
  userId: Schema.String,
  /** The user's own pools, each with a pool link the preview routes it through. */
  pools: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      personal: Schema.Boolean,
      token: Schema.String,
    }),
  ),
  /** Sections and project placements as stored before folders: what an older preview reads. */
  sections: SectionRows,
  /** Folders and the resources placed at them. Absent from a cloud from before folders. */
  folders: Schema.optionalKey(FolderRows),
  /** Pipes keeps the tokens under the WorkOS user, which production and previews share. */
  github: Schema.NullOr(Schema.Struct({ login: Schema.String, githubUserId: Schema.Number })),
});
export type PreviewSetup = typeof PreviewSetup.Type;

/** How `redeem` answers each refusal over HTTP. */
export const REDEEM_ERROR_STATUS = { expired: 404, rejected: 403, failed: 500 } as const;

/** Why production won't hand over a setup. Only `failed` is worth trying again. */
export class PreviewSetupRedeemError extends Schema.TaggedError<PreviewSetupRedeemError>()(
  "PreviewSetupRedeemError",
  { reason: Schema.Literals(["expired", "rejected", "failed"]) },
) {
  override get message() {
    return `Production would not hand over the setup (${this.reason}).`;
  }
}
