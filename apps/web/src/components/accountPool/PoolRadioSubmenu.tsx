// signalbox: "Pool for this folder" in a folder's or section's menu: inherit from above, or a pool.
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import { LayersIcon } from "lucide-react";

import { MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";

const INHERIT_POOL = "inherit";

export function PoolRadioSubmenu(props: {
  pools: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The pool placed here; null or undefined inherits it. */
  value: AccountPoolId | null | undefined;
  /** What it runs on when it inherits: the level above's pool. */
  inheritedPoolName: string | undefined;
  onChange: (poolId: AccountPoolId | null) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <LayersIcon />
        Pool for this folder
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          value={props.value ?? INHERIT_POOL}
          onValueChange={(value) =>
            props.onChange(value === INHERIT_POOL ? null : AccountPoolId.make(value))
          }
        >
          <MenuRadioItem value={INHERIT_POOL}>
            Inherit from above
            {props.inheritedPoolName ? (
              <span className="ms-auto ps-4 text-muted-foreground">{props.inheritedPoolName}</span>
            ) : null}
          </MenuRadioItem>
          {props.pools.map((pool) => (
            <MenuRadioItem key={pool.id} value={pool.id}>
              {pool.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
