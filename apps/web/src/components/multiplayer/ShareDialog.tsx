/**
 * Drive-style Share dialog for a team, project, or item (chat, task, room):
 * add people, people with access (inherited rows point at their source), and
 * general access. With `actions`, an item's people, roles and general access
 * are editable (teamless containers only have "Only people added"). Preview.
 */
import { ChevronDownIcon, LinkIcon, LockIcon, MailIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PersonAvatar } from "./PersonAvatar";
import { AddPeopleField, GeneralAccessControl } from "./ShareDialogControls";
import {
  SHARE_ROLE_LABEL,
  accessFor,
  peopleWithAccess,
  sharingTeamId,
  type AccessRow,
  type ShareRole,
  type ShareTarget,
} from "./sharing";
import { findTeam } from "./teamThreads";

/** Edits for an item target; `useAccessControls` confirms where needed. */
export interface ShareActions {
  readonly addPeople: (personIds: readonly string[]) => void;
  /** Someone outside the team, by email. */
  readonly invite: (email: string) => void;
  readonly removePerson: (personId: string) => void;
  readonly setRole: (personId: string, role: ShareRole) => void;
  readonly setGeneral: (scope: "team" | "restricted") => void;
}

const notify = (title: string) =>
  toastManager.add({ id: "share-dialog", type: "info", title, timeout: 2000 });

function RoleControl(props: {
  row: AccessRow;
  role: ShareRole;
  onChange: (role: ShareRole) => void;
  onRemove: (() => void) | undefined;
}) {
  if (props.row.inheritedFrom || props.role === "owner" || !props.row.editable) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">{SHARE_ROLE_LABEL[props.role]}</span>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        {SHARE_ROLE_LABEL[props.role]}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={props.role}
          onValueChange={(value) => {
            if (value === "reply" || value === "view") props.onChange(value);
          }}
        >
          <MenuRadioItem value="reply">Can reply</MenuRadioItem>
          <MenuRadioItem value="view">Viewer</MenuRadioItem>
        </MenuRadioGroup>
        {props.onRemove ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onRemove}>
              Remove access
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function AccessLine(props: {
  row: AccessRow;
  role: ShareRole;
  onChange: (role: ShareRole) => void;
  onRemove: (() => void) | undefined;
}) {
  const { principal } = props.row;
  return (
    <li className="flex items-center gap-3">
      {principal.kind === "person" ? (
        <PersonAvatar person={principal.person} />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {principal.kind === "invite" ? (
            <MailIcon className="size-4" />
          ) : (
            <UsersIcon className="size-4" />
          )}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">
          {principal.kind === "person"
            ? principal.person.name
            : principal.kind === "invite"
              ? principal.email
              : principal.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {props.row.inheritedFrom
            ? `Inherited from ${props.row.inheritedFrom}`
            : principal.kind === "person"
              ? principal.person.email
              : principal.kind === "invite"
                ? "Invite pending"
                : `${principal.memberCount} members`}
        </span>
      </div>
      <RoleControl
        row={props.row}
        role={props.role}
        onChange={props.onChange}
        onRemove={props.onRemove}
      />
    </li>
  );
}

function InviteField() {
  const [invite, setInvite] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (invite.trim()) notify(`Invited ${invite.trim()}`);
        setInvite("");
      }}
    >
      <Input
        value={invite}
        onChange={(event) => setInvite(event.currentTarget.value)}
        placeholder="Add people or groups"
        aria-label="Add people or groups"
      />
      <Button type="submit" variant="outline" disabled={!invite.trim()}>
        Invite
      </Button>
    </form>
  );
}

export function ShareDialog(props: {
  target: ShareTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ShareActions;
}) {
  const access = accessFor(props.target);
  const [roles, setRoles] = useState<Record<string, ShareRole>>({});
  const GeneralIcon = access.general.scope === "team" ? UsersIcon : LockIcon;
  const item = props.target.kind === "item" ? props.target.item : null;
  const actions = item ? props.actions : undefined;
  const teamId = item ? sharingTeamId(item.containerId) : null;
  const teamName = teamId ? findTeam(teamId)?.name : undefined;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{access.title}</DialogTitle>
          {access.description ? <DialogDescription>{access.description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          {item && actions ? (
            <AddPeopleField
              excludedIds={new Set(peopleWithAccess(item).map((person) => person.id))}
              onAdd={actions.addPeople}
              onInvite={actions.invite}
            />
          ) : (
            <InviteField />
          )}
          <section aria-label="People with access" className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">People with access</h3>
            <ul className="flex flex-col gap-3">
              {access.rows.map((row) => (
                <AccessLine
                  key={row.key}
                  row={row}
                  role={roles[row.key] ?? row.role}
                  onChange={(role) => {
                    if (actions && row.principal.kind === "person") {
                      actions.setRole(row.principal.person.id, role);
                    } else {
                      setRoles((current) => ({ ...current, [row.key]: role }));
                    }
                  }}
                  onRemove={
                    actions && row.editable && row.principal.kind === "person"
                      ? () => {
                          if (row.principal.kind === "person") {
                            actions.removePerson(row.principal.person.id);
                          }
                        }
                      : undefined
                  }
                />
              ))}
            </ul>
          </section>
          <section aria-label="General access" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">General access</h3>
            <div className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <GeneralIcon className="size-4" />
              </span>
              <div className="flex min-w-0 flex-col items-start">
                {actions && teamName ? (
                  <GeneralAccessControl
                    scope={access.general.scope}
                    teamName={teamName}
                    onChange={actions.setGeneral}
                  />
                ) : (
                  <span className="text-sm text-foreground">{access.general.label}</span>
                )}
                <span className="text-xs text-muted-foreground">{access.general.detail}</span>
              </div>
            </div>
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href).then(
                () => notify("Link copied"),
                () => notify("Couldn't copy the link"),
              );
            }}
          >
            <LinkIcon />
            Copy link
          </Button>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
