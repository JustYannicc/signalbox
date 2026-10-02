import { ShieldCheckIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { PersonAvatar } from "../multiplayer/PersonAvatar";
import { TEAM_PEOPLE } from "../multiplayer/multiplayerFixtures";
import { Button } from "../ui/button";
import { AccountRow } from "./AccountRow";
import {
  plural,
  poolCapacity,
  type AccountGroup,
  type AccountPool,
  type PoolGrant,
} from "./accountPoolsModel";
import { PoolMark } from "./accountPoolsPrimitives";
import { grantLabel, SharePoolDialog } from "./SharePoolDialog";

const PERSON_BY_ID = new Map(TEAM_PEOPLE.map((person) => [person.id, person]));

/**
 * One pool: header with capacity and sharing, then its accounts. Your pools
 * get a Share button; pools shared with you get Connect or Leave, and only
 * list their accounts once connected.
 */
export function PoolBlock({
  pool,
  owned,
  connected,
  onConnectedChange,
  groupsById,
  now,
}: {
  readonly pool: AccountPool;
  readonly owned: boolean;
  readonly connected: boolean;
  readonly onConnectedChange: (connected: boolean) => void;
  readonly groupsById: ReadonlyMap<string, AccountGroup>;
  readonly now: number;
}) {
  const [grants, setGrants] = useState<readonly PoolGrant[]>(pool.grants);
  const [sharing, setSharing] = useState(false);
  const capacity = poolCapacity(pool.harness, pool.accounts);
  const owner = PERSON_BY_ID.get(pool.ownerId);
  const showAccounts = owned || connected;

  return (
    <section aria-labelledby={`pool-${pool.id}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PoolMark harness={pool.harness} className="size-4" />
          <h3 id={`pool-${pool.id}`} className="truncate text-sm font-medium text-foreground">
            {pool.name}
          </h3>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {plural(pool.accounts.length, "account")}
            {showAccounts ? ` · ${capacity.left.toFixed(1)} of ${capacity.serving} left` : ""}
          </span>
        </div>
        {owned ? (
          <>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {grants.length === 0
                ? "Private"
                : `Shared with ${grants.map((grant) => grantLabel(grant)).join(", ")}`}
            </span>
            <Button size="xs" variant="outline" onClick={() => setSharing(true)}>
              <UsersIcon aria-hidden />
              Share
            </Button>
            <SharePoolDialog
              pool={pool}
              grants={grants}
              onGrantsChange={setGrants}
              open={sharing}
              onOpenChange={setSharing}
            />
          </>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {pool.orgName ? (
                <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
              ) : owner ? (
                <PersonAvatar person={owner} size="xs" />
              ) : null}
              <span className="truncate">
                Shared by {owner?.name ?? pool.ownerId}
                {pool.orgName ? ` · ${pool.orgName} admins` : ""}
              </span>
            </span>
            <Button
              size="xs"
              variant={connected ? "ghost-muted" : "outline"}
              onClick={() => onConnectedChange(!connected)}
            >
              {connected ? "Leave" : "Connect"}
            </Button>
          </>
        )}
      </div>
      {showAccounts ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {pool.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              groups={account.groupIds.flatMap((id) => {
                const group = groupsById.get(id);
                return group ? [group] : [];
              })}
              now={now}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
