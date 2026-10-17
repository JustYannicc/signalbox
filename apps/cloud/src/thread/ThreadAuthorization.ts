/** What a drive token lets its holder do right now (see `drive/driveRoutes.ts`). */
export type DriveAuthorization =
  | {
      readonly _tag: "granted";
      readonly threadId: string;
      /** The thread's owner, whose role the drive checks again on every write. */
      readonly userId: string;
      readonly driveId: string;
      readonly generation: number;
      /** Whether a turn runs: `main` only moves during one. */
      readonly live: boolean;
    }
  | { readonly _tag: "denied"; readonly reason: string }
  /** The owner's access couldn't be checked just now; the Runner retries. */
  | { readonly _tag: "unavailable" };

/** What a remote token lets its holder fetch right now. */
export type RemoteAuthorization =
  | {
      readonly _tag: "granted";
      readonly threadId: string;
      readonly driveId: string;
      /** Whose GitHub connection reaches the remote. */
      readonly userId: string;
    }
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "unavailable" };
