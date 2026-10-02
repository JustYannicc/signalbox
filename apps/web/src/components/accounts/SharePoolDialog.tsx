/**
 * Drive-style sharing for an account pool: add people or a whole group, pick
 * "Can use" or "Can manage". Same look as the multiplayer Share dialog, whose
 * targets are containers and items rather than pools.
 */
import { ChevronDownIcon, PlusIcon, UsersIcon } from "lucide-react";

import { AddPeopleField } from "../multiplayer/ShareDialogControls";
import { PersonAvatar } from "../multiplayer/PersonAvatar";
import { TEAM_PEOPLE } from "../multiplayer/multiplayerFixtures";
import { ACCOUNT_GROUPS_FROM_PLUGINS } from "../plugins/groupsFixtures";
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
import {
  POOL_ROLE_LABEL,
  type AccountPool,
  type PoolGrant,
  type PoolRole,
} from "./accountPoolsModel";

const PERSON_BY_ID = new Map(TEAM_PEOPLE.map((person) => [person.id, person]));
const GROUP_BY_ID = new Map(ACCOUNT_GROUPS_FROM_PLUGINS.map((group) => [group.id, group]));

export const grantKey = (grant: PoolGrant) =>
  grant.kind === "person" ? `person:${grant.personId}` : `group:${grant.groupId}`;

export function grantLabel(grant: PoolGrant): string {
  return grant.kind === "person"
    ? (PERSON_BY_ID.get(grant.personId)?.name ?? grant.personId)
    : `${GROUP_BY_ID.get(grant.groupId)?.label ?? grant.groupId} group`;
}

export function SharePoolDialog({
  pool,
  grants,
  onGrantsChange,
  open,
  onOpenChange,
}: {
  readonly pool: AccountPool;
  readonly grants: readonly PoolGrant[];
  readonly onGrantsChange: (grants: readonly PoolGrant[]) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const owner = PERSON_BY_ID.get(pool.ownerId);
  const sharedIds = new Set(
    grants.flatMap((grant) => (grant.kind === "person" ? [grant.personId] : [])),
  );
  const unsharedGroups = ACCOUNT_GROUPS_FROM_PLUGINS.filter(
    (group) => !grants.some((grant) => grant.kind === "group" && grant.groupId === group.id),
  );
  const add = (grant: PoolGrant) => onGrantsChange([...grants, grant]);
  const update = (key: string, role: PoolRole | null) =>
    onGrantsChange(
      role === null
        ? grants.filter((grant) => grantKey(grant) !== key)
        : grants.map((grant) => (grantKey(grant) === key ? { ...grant, role } : grant)),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Share “{pool.name}”</DialogTitle>
          <DialogDescription>
            People you add can route their agents through these accounts. They never see the
            sign-ins.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <AddPeopleField
                excludedIds={new Set([pool.ownerId, ...sharedIds])}
                onAdd={(ids) =>
                  ids.forEach((personId) => add({ kind: "person", personId, role: "use" }))
                }
                onInvite={(email) =>
                  toastManager.add({ type: "success", title: `Invited ${email}`, timeout: 2000 })
                }
              />
            </div>
            <Menu>
              <MenuTrigger
                render={<Button variant="outline" disabled={unsharedGroups.length === 0} />}
              >
                <PlusIcon aria-hidden />
                Group
              </MenuTrigger>
              <MenuPopup align="end">
                {unsharedGroups.map((group) => (
                  <MenuItem
                    key={group.id}
                    onClick={() => add({ kind: "group", groupId: group.id, role: "use" })}
                  >
                    {group.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </div>
          <section aria-label="People with access" className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">People with access</h3>
            <ul className="flex flex-col gap-3">
              {owner ? (
                <li className="flex items-center gap-3">
                  <PersonAvatar person={owner} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {owner.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pool.orgName ? `Owner · ${pool.orgName} admins` : "Owner"}
                  </span>
                </li>
              ) : null}
              {grants.map((grant) => {
                const person = grant.kind === "person" ? PERSON_BY_ID.get(grant.personId) : null;
                return (
                  <li key={grantKey(grant)} className="flex items-center gap-3">
                    {person ? (
                      <PersonAvatar person={person} />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <UsersIcon className="size-4" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {grantLabel(grant)}
                    </span>
                    <Menu>
                      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
                        {POOL_ROLE_LABEL[grant.role]}
                        <ChevronDownIcon aria-hidden />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuRadioGroup
                          value={grant.role}
                          onValueChange={(value) => {
                            if (value === "use" || value === "manage")
                              update(grantKey(grant), value);
                          }}
                        >
                          <MenuRadioItem value="use">{POOL_ROLE_LABEL.use}</MenuRadioItem>
                          <MenuRadioItem value="manage">{POOL_ROLE_LABEL.manage}</MenuRadioItem>
                        </MenuRadioGroup>
                        <MenuSeparator />
                        <MenuItem
                          variant="destructive"
                          onClick={() => update(grantKey(grant), null)}
                        >
                          Remove access
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </li>
                );
              })}
            </ul>
          </section>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
