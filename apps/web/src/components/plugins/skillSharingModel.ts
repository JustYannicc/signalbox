/**
 * Team skill sharing without git. A published skill is a folder in a group's
 * skills repo, listed on skills.sh; authors publish versions from the app
 * and subscribers' copies follow. The repo stays behind an "Advanced" fold.
 */
import type { GroupId } from "./pluginsModel";

export interface SkillVersion {
  readonly version: number;
  readonly author: string;
  readonly note: string;
  readonly when: string;
}

export interface SkillSubscriber {
  readonly name: string;
  readonly version: number;
  readonly autoUpdate: boolean;
}

/** What the latest publish did to your copy. */
export type SkillSync =
  | { readonly state: "current" }
  | { readonly state: "auto-updated"; readonly from: number; readonly when: string }
  | { readonly state: "update-available"; readonly latest: number };

export interface SkillPublication {
  readonly skillId: string;
  /** "you" when you can edit and publish new versions. */
  readonly owner: "you" | string;
  /** Published skills reach everyone in this group; admins may narrow it later. */
  readonly groupId: GroupId;
  /** Whether your own copy follows new versions without asking. */
  readonly autoUpdate: boolean;
  readonly yourVersion: number;
  /** Newest first. */
  readonly versions: readonly SkillVersion[];
  readonly subscribers: readonly SkillSubscriber[];
  readonly repo: string;
  readonly repoPath: string;
  readonly registry: string;
  readonly body: string;
}

export function latestVersion(publication: SkillPublication) {
  return publication.versions[0]?.version ?? 0;
}

export function skillSync(publication: SkillPublication): SkillSync {
  const latest = latestVersion(publication);
  if (publication.yourVersion >= latest) {
    const previous = publication.versions[1];
    return publication.owner !== "you" && publication.autoUpdate && previous
      ? { state: "auto-updated", from: previous.version, when: publication.versions[0]?.when ?? "" }
      : { state: "current" };
  }
  return { state: "update-available", latest };
}

export function subscribersBehind(publication: SkillPublication) {
  const latest = latestVersion(publication);
  return publication.subscribers.filter((subscriber) => subscriber.version < latest);
}

export function isOwnedByYou(publication: SkillPublication) {
  return publication.owner === "you";
}
