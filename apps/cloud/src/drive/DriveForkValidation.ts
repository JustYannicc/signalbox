import { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import * as Schema from "effect/Schema";

import type { DriveSnapshot, StoredCommit } from "./DriveStore.ts";
import type { Oid } from "./git/gitObjects.ts";
import { parseDriveId } from "./driveAccess.ts";

const hasKeys = (value: unknown, keys: ReadonlyArray<string>) =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).toSorted().join("\n") === [...keys].toSorted().join("\n");

const isOid = (value: unknown): value is Oid =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);

/** Checks the serialized boundary before a snapshot can alter a new drive. */
export const validateDriveSnapshot = (snapshot: DriveSnapshot, targetId: string): string | null => {
  if (!hasKeys(snapshot, ["sourceDriveId", "main", "remote", "packs", "commits", "promised"])) {
    return "The snapshot contains unsupported drive state.";
  }
  if (typeof snapshot.sourceDriveId !== "string")
    return "The snapshot has an invalid source drive.";
  try {
    if (parseDriveId(snapshot.sourceDriveId) === null || snapshot.sourceDriveId === targetId) {
      return "The snapshot has an invalid source drive.";
    }
  } catch {
    return "The snapshot has an invalid source drive.";
  }
  if (snapshot.main !== null && !isOid(snapshot.main)) {
    return "The snapshot has an invalid main ref.";
  }
  if (
    !Array.isArray(snapshot.packs) ||
    !Array.isArray(snapshot.commits) ||
    !Array.isArray(snapshot.promised)
  ) {
    return "The snapshot is incomplete.";
  }
  if (snapshot.remote !== null) {
    try {
      Schema.decodeUnknownSync(DriveRemote)(snapshot.remote);
    } catch {
      return "The snapshot has invalid remote metadata.";
    }
  }

  const packNames = new Set<string>();
  const shallow = new Set<Oid>();
  const commits = new Map<Oid, StoredCommit>();
  const commitObjects = new Set<Oid>();
  for (const pack of snapshot.packs) {
    if (!hasKeys(pack, ["name", "size", "origin", "entries", "shallow"])) {
      return "The snapshot contains private or unsupported pack metadata.";
    }
    if (
      !isOid(pack.name) ||
      packNames.has(pack.name) ||
      !Number.isSafeInteger(pack.size) ||
      pack.size < 0 ||
      !hasKeys(pack.origin, ["driveId", "name"]) ||
      !isOid(pack.origin.name) ||
      pack.origin.name !== pack.name
    ) {
      return "The snapshot has invalid pack metadata.";
    }
    try {
      if (parseDriveId(pack.origin.driveId) === null || pack.origin.driveId === targetId) {
        return "The snapshot has an invalid pack origin.";
      }
    } catch {
      return "The snapshot has an invalid pack origin.";
    }
    if (!Array.isArray(pack.entries) || !Array.isArray(pack.shallow)) {
      return "The snapshot has incomplete pack metadata.";
    }
    packNames.add(pack.name);
    for (const entry of pack.entries) {
      if (
        !hasKeys(entry, ["oid", "offset", "length", "type", "size"]) ||
        !isOid(entry.oid) ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        !Number.isSafeInteger(entry.length) ||
        entry.length <= 0 ||
        entry.offset + entry.length > pack.size ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !["commit", "tree", "blob", "tag"].includes(entry.type)
      ) {
        return "The snapshot has invalid pack metadata.";
      }
      if (entry.type === "commit") commitObjects.add(entry.oid);
    }
    for (const oid of pack.shallow) {
      if (!isOid(oid)) return "The snapshot has invalid shallow history.";
      shallow.add(oid);
    }
  }
  for (const commit of snapshot.commits) {
    if (
      !hasKeys(commit, [
        "oid",
        "tree",
        "parents",
        "authorName",
        "authorEmail",
        "time",
        "message",
      ]) ||
      !isOid(commit.oid) ||
      !isOid(commit.tree) ||
      !Array.isArray(commit.parents) ||
      !commit.parents.every(isOid) ||
      typeof commit.authorName !== "string" ||
      typeof commit.authorEmail !== "string" ||
      !Number.isFinite(commit.time) ||
      typeof commit.message !== "string" ||
      commits.has(commit.oid)
    ) {
      return "The snapshot has invalid commit metadata.";
    }
    commits.set(commit.oid, commit);
  }
  if (
    snapshot.main !== null &&
    (!commits.has(snapshot.main) || !commitObjects.has(snapshot.main))
  ) {
    return "The snapshot does not include its main commit.";
  }
  for (const oid of shallow) {
    if (!commits.has(oid)) return "The snapshot's shallow history is inconsistent.";
  }

  const reachable = new Set<Oid>();
  const pending = snapshot.main === null ? [] : [snapshot.main];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (reachable.has(oid)) continue;
    const commit = commits.get(oid);
    if (commit === undefined) return "The snapshot has a missing parent commit.";
    reachable.add(oid);
    for (const parent of commit.parents) {
      if (commits.has(parent)) pending.push(parent);
      else if (!shallow.has(oid)) return "The snapshot has incomplete commit history.";
    }
  }
  if (reachable.size !== commits.size) return "The snapshot includes history outside its main ref.";

  const promised = new Set<Oid>();
  for (const file of snapshot.promised) {
    if (
      !hasKeys(file, ["oid", "size"]) ||
      !isOid(file.oid) ||
      (file.size !== null && (!Number.isSafeInteger(file.size) || file.size < 0)) ||
      promised.has(file.oid)
    ) {
      return "The snapshot has invalid promised-file metadata.";
    }
    promised.add(file.oid);
  }
  return null;
};
