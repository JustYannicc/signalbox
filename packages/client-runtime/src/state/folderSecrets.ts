import {
  type FolderLevel,
  type FolderSecrets,
  type SignalboxFoldersSnapshot,
  OnePasswordEnvironmentId,
  OnePasswordServiceAccountToken,
  SecretEnvironmentName,
} from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { folderPath } from "./foldersModel.ts";

const decodeEnvironmentId = Schema.decodeUnknownOption(OnePasswordEnvironmentId);
const decodeToken = Schema.decodeUnknownOption(OnePasswordServiceAccountToken);

/** A level's source and its own-folder-to-descendants allowlist. */
export function levelSecrets(
  snapshot: SignalboxFoldersSnapshot,
  level: FolderLevel,
): FolderSecrets | null {
  if (level._tag === "top") return snapshot.top.secrets ?? null;
  const folder = snapshot.folders.find((candidate) => candidate.id === level.folderId);
  return folder?.secrets ?? null;
}

/** Ancestor sources that opted keys into subfolders, nearest first. */
export function secretSourcesAbove(
  snapshot: SignalboxFoldersSnapshot,
  level: FolderLevel,
): ReadonlyArray<string> {
  if (level._tag === "top") return [];
  const folder = snapshot.folders.find((candidate) => candidate.id === level.folderId);
  if (folder === undefined) return [];
  const sources: Array<string> = [];
  for (const above of folderPath(snapshot, folder.parentId)) {
    if ((above.secrets?.includeSubfolders?.length ?? 0) > 0) sources.unshift(`“${above.name}”`);
  }
  if ((snapshot.top.secrets?.includeSubfolders?.length ?? 0) > 0) sources.push("the top level");
  return sources;
}

/** "“Work”", "“Work” and the top level", or an empty string. */
export function formatSecretSources(sources: ReadonlyArray<string>): string {
  if (sources.length <= 1) return sources[0] ?? "";
  return `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
}

export const isSecretEnvironmentName = Schema.is(SecretEnvironmentName);

/** Adds a key name to the editor's local list; only included names are saved. */
export function addSubfolderSecretName(
  names: ReadonlyArray<string>,
  rawName: string,
): ReadonlyArray<string> {
  const name = rawName.trim();
  if (!isSecretEnvironmentName(name) || names.includes(name)) return names;
  return [...names, name];
}

/** Names belong to one Environment; a source change starts with an empty list. */
export function resetSubfolderSecretNamesForEnvironment(
  currentEnvironmentId: string,
  nextEnvironmentId: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return currentEnvironmentId.trim() === nextEnvironmentId.trim() ? names : [];
}

/** Changes one key's allowlist state, leaving names in the editor reversible. */
export function setSubfolderSecretIncluded(
  included: ReadonlyArray<string>,
  rawName: string,
  shouldInclude: boolean,
): ReadonlyArray<string> {
  const name = rawName.trim();
  if (!isSecretEnvironmentName(name)) return included;
  if (shouldInclude) {
    return included.includes(name) ? included : [...included, name];
  }
  return included.filter((candidate) => candidate !== name);
}

export type SecretsSave =
  | { readonly error: string }
  | {
      readonly connect: string | null;
      /** Absent means unchanged; null removes this level's source. */
      readonly secrets?: FolderSecrets | null;
    };

/** Validates the form and plans one connection change and one full source update. */
export function planSecretsSave(input: {
  readonly current: FolderSecrets | null;
  readonly environmentId: string;
  /** Omit to keep the allowlist only when the current Environment stays selected. */
  readonly includeSubfolders?: ReadonlyArray<string>;
  readonly token: string | null;
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
  let nextEnvironmentId: FolderSecrets["environmentId"] | null = null;
  if (typedId.length > 0) {
    const decoded = decodeEnvironmentId(typedId);
    if (Option.isNone(decoded)) {
      return {
        error:
          "That isn't an Environment ID. In 1Password, open the Environment and copy its ID from Manage environment.",
      };
    }
    nextEnvironmentId = decoded.value;
  }

  if (nextEnvironmentId !== null && !input.connected && connect === null) {
    return { error: "Add your service account token too, so Signalbox can read this Environment." };
  }

  const sourceChanged = input.current?.environmentId !== nextEnvironmentId;
  const rawNames =
    input.includeSubfolders ?? (sourceChanged ? [] : (input.current?.includeSubfolders ?? []));
  const includeSubfolders: Array<string> = [];
  for (const rawName of rawNames) {
    const name = rawName.trim();
    if (!isSecretEnvironmentName(name)) {
      return { error: `“${rawName}” isn't a valid environment variable name.` };
    }
    if (!includeSubfolders.includes(name)) includeSubfolders.push(name);
  }

  const currentNames = input.current?.includeSubfolders ?? [];
  const sourceUnchanged =
    input.current === null
      ? nextEnvironmentId === null
      : nextEnvironmentId === input.current.environmentId &&
        sameNames(currentNames, includeSubfolders);
  if (sourceUnchanged) return { connect };

  const secrets: FolderSecrets | null =
    nextEnvironmentId === null ? null : { environmentId: nextEnvironmentId, includeSubfolders };
  return { connect, secrets };
}

function sameNames(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}
