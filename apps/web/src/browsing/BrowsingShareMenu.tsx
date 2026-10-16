"use client";

import { useAtomValue } from "@effect/atom-react";
import { browsingShareMenu, isOwnedBy } from "@t3tools/client-runtime/browsing";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { BrowsingCommand, BrowsingSharing } from "@t3tools/contracts/signalboxBrowsing";
import { UsersRoundIcon } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { dispatchBrowsingCommand, threadBrowsingStateAtom } from "./threadBrowsingSync";

/**
 * Sharing one of your own synced tabs with the thread (#597): for a while or
 * until you stop, with who can see it and until when. Memoized on `sharing`,
 * which keeps its reference while the tab's position changes.
 */
export const BrowsingShareMenu = memo(function BrowsingShareMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly sharing: BrowsingSharing | undefined;
}) {
  const { threadRef } = props;
  // When the menu mounted is close enough: the thread ends a share itself, and that lands live.
  const [now] = useState(Date.now);
  const menu = browsingShareMenu({ id: props.tabId, sharing: props.sharing }, now);
  const run = (command: BrowsingCommand) =>
    void dispatchBrowsingCommand(threadRef, command).then((sequence) => {
      if (sequence !== null) return;
      toastManager.add({
        type: "error",
        title: command._tag === "Unshare" ? "Couldn't stop sharing" : "Couldn't share this tab",
      });
    });
  const stop = menu.stop;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant={menu.shared ? "secondary" : "ghost"}
                  size="icon-xs"
                  type="button"
                  aria-label={menu.label}
                  aria-pressed={menu.shared}
                />
              }
            />
          }
        >
          <UsersRoundIcon />
        </TooltipTrigger>
        <TooltipPopup>{menu.label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="max-w-72">
        <MenuGroup>
          <MenuGroupLabel>
            <span className="block whitespace-normal">{menu.note}</span>
          </MenuGroupLabel>
          {menu.choices.map((choice) => (
            <MenuItem key={choice.key} onClick={() => run(choice.command)}>
              {choice.title}
            </MenuItem>
          ))}
        </MenuGroup>
        {stop !== null ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => run(stop)}>
              Stop sharing
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

/** The share menu for the panel's tab, when this person owns it in a synced thread; else nothing. */
export function BrowsingShareControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string | null | undefined;
}) {
  const state = useAtomValue(threadBrowsingStateAtom(scopedThreadKey(props.threadRef)));
  const tab = state?.record.tabs.find((candidate) => candidate.id === props.tabId);
  if (tab === undefined || !isOwnedBy(tab, state?.you ?? null)) return null;
  return <BrowsingShareMenu threadRef={props.threadRef} tabId={tab.id} sharing={tab.sharing} />;
}
