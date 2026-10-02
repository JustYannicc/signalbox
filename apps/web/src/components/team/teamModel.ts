/**
 * Shapes for the Team prototype: one team (a team Section in Home), its
 * members and invites, and the company agents that act for it. People come
 * from the multiplayer fixtures so every surface shows the same team.
 */
import type { TeamPerson } from "../multiplayer/multiplayerModel";
import { toastManager } from "../ui/toast";

export type MemberRole = TeamPerson["role"];

export const MEMBER_ROLES: readonly MemberRole[] = ["Owner", "Admin", "Member", "Guest"];

/** Roles an admin can hand out; ownership moves through its own flow. */
export const ASSIGNABLE_ROLES: readonly MemberRole[] = ["Admin", "Member", "Guest"];

/**
 * An organization your own account is connected to. Leaving drops its
 * sections, pools and connections; everything personal stays yours.
 */
export interface ConnectedOrganization {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly memberSince: string;
  readonly signIn: string;
  /** The team (and its Home section) this organization's work lives in. */
  readonly teamId: string;
}

export interface PendingInvite {
  readonly email: string;
  readonly role: MemberRole;
  readonly sent: string;
}

/** An agent that acts for the company and asks people's own agents for what it needs. */
export interface CompanyAgent {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  /** What it may ask a person's agent for; their agent decides what to hand over. */
  readonly mayAsk: string;
}

export function isMemberRole(value: unknown): value is MemberRole {
  return MEMBER_ROLES.some((role) => role === value);
}

export function canManage(role: MemberRole): boolean {
  return role === "Owner" || role === "Admin";
}

export function notifyTeamComingSoon(action: string) {
  toastManager.add({
    id: "team-coming-soon",
    type: "info",
    title: `${action} is coming soon`,
    description: "Team is a preview on placeholder data.",
    timeout: 2500,
  });
}
