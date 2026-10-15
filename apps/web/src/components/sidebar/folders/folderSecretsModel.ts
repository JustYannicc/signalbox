/**
 * What the Secrets dialog shows and saves (#395): a level's 1Password
 * Environment, the levels above whose Environments its threads also get,
 * and what a Save has to send. Pure, so the dialog stays a view of it.
 */
import { folderPath } from "@t3tools/client-runtime/state/signalboxFolders";
import {
  type FolderLevel,
  OnePasswordEnvironmentId,
  OnePasswordServiceAccountToken,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEnvironmentId = Schema.decodeUnknownOption(OnePasswordEnvironmentId);
const decodeToken = Schema.decodeUnknownOption(OnePasswordServiceAccountToken);

/** The Environment a level names itself: null when none (or the folder is gone). */
export function levelSecrets(
  snapshot: SignalboxFoldersSnapshot,
  level: FolderLevel,
): OnePasswordEnvironmentId | null {
  if (level._tag === "top") return snapshot.top.secrets?.environmentId ?? null;
  const folder = snapshot.folders.find((candidate) => candidate.id === level.folderId);
  return folder?.secrets?.environmentId ?? null;
}

/**
 * The levels above `level` that name an Environment, nearest first, as the
 * dialog names them: “Work”, then “the top level”. A thread gets all of
 * them; a nearer level's variable replaces one of the same name.
 */
export function secretSourcesAbove(
  snapshot: SignalboxFoldersSnapshot,
  level: FolderLevel,
): ReadonlyArray<string> {
  if (level._tag === "top") return [];
  const folder = snapshot.folders.find((candidate) => candidate.id === level.folderId);
  if (folder === undefined) return [];
  const sources = folderPath(snapshot, folder.parentId)
    .filter((above) => above.secrets !== undefined)
    .map((above) => `“${above.name}”`)
    .toReversed();
  if (snapshot.top.secrets !== undefined) sources.push("the top level");
  return sources;
}

/** "“Work”", "“Work” and the top level", "“Clients”, “Work” and the top level". */
export function formatSources(sources: ReadonlyArray<string>): string {
  if (sources.length <= 1) return sources[0] ?? "";
  return `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
}

/**
 * What saving the dialog sends: a token to connect first (null: none), then
 * the level's Environment (absent: unchanged, null: removed). Or why it can't.
 */
export type SecretsSave =
  | { readonly error: string }
  | {
      readonly connect: string | null;
      readonly environmentId?: OnePasswordEnvironmentId | null;
    };

export function planSecretsSave(input: {
  /** What the level names now. */
  readonly current: OnePasswordEnvironmentId | null;
  /** The Environment ID field, as typed. */
  readonly environmentId: string;
  /** The token field as typed; null when it isn't shown. */
  readonly token: string | null;
  /** Whether a token is connected already. */
  readonly connected: boolean;
}): SecretsSave {
  const typedToken = input.token?.trim() ?? "";
  let connect: string | null = null;
  if (typedToken.length > 0) {
    if (Option.isNone(decodeToken(typedToken))) {
      return { error: "That isn't a service account token. It starts with ops_." };
    }
    connect = typedToken;
  }

  const typedId = input.environmentId.trim();
  let next: OnePasswordEnvironmentId | null = null;
  if (typedId.length > 0) {
    const decoded = decodeEnvironmentId(typedId);
    if (Option.isNone(decoded)) {
      return {
        error:
          "That isn't an Environment ID. In 1Password, open the Environment and copy its ID from Manage environment.",
      };
    }
    next = decoded.value;
  }

  if (next !== null && !input.connected && connect === null) {
    return { error: "Add your service account token too, so Signalbox can read this Environment." };
  }
  return next === input.current ? { connect } : { connect, environmentId: next };
}
