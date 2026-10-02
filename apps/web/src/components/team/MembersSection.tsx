import {
  EllipsisIcon,
  MailIcon,
  SendIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { PersonAvatar } from "../multiplayer/PersonAvatar";
import type { TeamPerson } from "../multiplayer/multiplayerModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  ASSIGNABLE_ROLES,
  canManage,
  isMemberRole,
  type MemberRole,
  type PendingInvite,
} from "./teamModel";
import { SectionHeading } from "./teamPrimitives";

export function MembersSection({
  members,
  initialInvites,
  signIn,
  viewerId,
  viewerRole,
}: {
  readonly members: readonly TeamPerson[];
  readonly initialInvites: readonly PendingInvite[];
  readonly signIn: string;
  readonly viewerId: string;
  readonly viewerRole: MemberRole;
}) {
  const [roles, setRoles] = useState<Record<string, MemberRole>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [invites, setInvites] = useState<readonly PendingInvite[]>(initialInvites);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("Member");
  const manages = canManage(viewerRole);

  const sendInvite = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address.includes("@") || invites.some((invite) => invite.email === address)) return;
    setInvites((current) => [...current, { email: address, role: inviteRole, sent: "Just now" }]);
    setEmail("");
  };

  return (
    <section aria-labelledby="team-members" className="flex flex-col gap-3">
      <SectionHeading id="team-members" title="Members" />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">
          <ShieldCheckIcon aria-hidden />
          WorkOS SSO
        </Badge>
        <span>{signIn}</span>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {members
          .filter((person) => !removed.has(person.id))
          .map((person) => {
            const role = roles[person.id] ?? person.role;
            const editable = manages && person.role !== "Owner" && person.id !== viewerId;
            return (
              <li key={person.id} className="flex items-center gap-3 px-3 py-2.5">
                <PersonAvatar person={person} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {person.name}
                    {person.id === viewerId ? (
                      <span className="font-normal text-muted-foreground"> (you)</span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{person.email}</span>
                </div>
                {editable ? (
                  <Select
                    value={role}
                    onValueChange={(next) => {
                      if (isMemberRole(next))
                        setRoles((current) => ({ ...current, [person.id]: next }));
                    }}
                  >
                    <SelectTrigger
                      aria-label={`Role for ${person.name}`}
                      size="compact"
                      variant="ghost"
                      className="w-auto min-w-0"
                    >
                      <SelectValue>{role}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {ASSIGNABLE_ROLES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="px-2 text-xs text-muted-foreground">{role}</span>
                )}
                <RowMenu label={`Actions for ${person.name}`} disabled={!editable}>
                  <MenuItem
                    variant="destructive"
                    onClick={() => setRemoved((current) => new Set(current).add(person.id))}
                  >
                    <UserMinusIcon aria-hidden />
                    Remove from team
                  </MenuItem>
                </RowMenu>
              </li>
            );
          })}
        {invites.map((invite) => (
          <li key={invite.email} className="flex items-center gap-3 px-3 py-2.5">
            <span
              aria-hidden
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
            >
              <MailIcon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">{invite.email}</span>
              <span className="text-xs text-muted-foreground">
                Invited {invite.sent.toLowerCase()}
              </span>
            </div>
            <span className="px-2 text-xs text-muted-foreground">{invite.role}</span>
            <RowMenu label={`Actions for invite to ${invite.email}`} disabled={!manages}>
              <MenuItem
                onClick={() =>
                  toastManager.add({
                    type: "success",
                    title: `Invite resent to ${invite.email}`,
                    timeout: 2000,
                  })
                }
              >
                <SendIcon aria-hidden />
                Resend invite
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() =>
                  setInvites((current) => current.filter((entry) => entry.email !== invite.email))
                }
              >
                <XIcon aria-hidden />
                Revoke invite
              </MenuItem>
            </RowMenu>
          </li>
        ))}
      </ul>

      {manages ? (
        <form onSubmit={sendInvite} className="flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1">
            <Input
              type="email"
              size="sm"
              aria-label="Invite by email"
              placeholder="name@northwind.example"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Select
            value={inviteRole}
            onValueChange={(next) => {
              if (isMemberRole(next)) setInviteRole(next);
            }}
          >
            <SelectTrigger aria-label="Invite role" size="sm" className="w-auto min-w-28">
              <SelectValue>{inviteRole}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {ASSIGNABLE_ROLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button type="submit" size="sm" disabled={!email.includes("@")}>
            Send invite
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">Ask an admin to invite people.</p>
      )}
    </section>
  );
}

/** A trailing "…" menu; disabled rows keep the slot so columns stay aligned. */
function RowMenu({
  label,
  disabled,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-xs" disabled={disabled} />}
        aria-label={label}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  );
}
