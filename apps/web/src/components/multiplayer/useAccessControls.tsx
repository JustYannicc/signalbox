/**
 * Share and unshare any item, with the principled rules and nothing else:
 * - Showing an item to more people confirms first (they'll see the history),
 *   unless the person already asked inline, e.g. the mention banner.
 * - Taking access from someone who posted (going private, or removing them)
 *   offers a private fork instead: their turns aren't yours to hide.
 * - A room is also its other owner's: widening it asks them first.
 * Returns the actions plus the dialogs to render once.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { forkItem } from "./forks";
import { logTeamEvent } from "./localMessages";
import { useItemGrantsStore } from "./itemAccess";
import { firstName, type TeamPerson } from "./multiplayerModel";
import { ShareDialog } from "./ShareDialog";
import {
  joinNames,
  peopleWithAccess,
  sharingTeamId,
  type AccessItem,
  type ShareRole,
} from "./sharing";
import { currentPerson, findTeam, peopleByIds, useThreadVisibilityStore } from "./teamThreads";

type Audience =
  | { readonly kind: "team" }
  | { readonly kind: "people"; readonly ids: readonly string[] }
  | { readonly kind: "email"; readonly email: string };
type DialogState =
  | { readonly kind: "share" }
  | { readonly kind: "confirm"; readonly audience: Audience; readonly fromShare: boolean }
  | { readonly kind: "ask-owner"; readonly fromShare: boolean }
  | { readonly kind: "fork"; readonly posters: readonly string[]; readonly fromShare: boolean }
  | null;

export interface AccessControls {
  readonly item: AccessItem;
  readonly openShareDialog: () => void;
  /** Confirms, then shares with the team or the given people. */
  readonly requestShare: (audience: "team" | readonly string[]) => void;
  /** Private right away, or the fork offer when others posted. */
  readonly requestPrivate: () => void;
  /** No confirm: the caller already asked, e.g. the mention banner. */
  readonly shareAndNotify: (people: readonly TeamPerson[]) => void;
  readonly dialogs: ReactNode;
}

function notify(title: string, description = "Preview only; nothing left this device.") {
  toastManager.add({ id: "item-access", type: "success", title, description, timeout: 2500 });
}

export function useAccessControls(item: AccessItem): AccessControls {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>(null);
  const teamId = sharingTeamId(item.containerId);
  const teamName = (teamId ? findTeam(teamId)?.name : null) ?? "your team";
  const otherOwner = peopleByIds(item.ownerIds).find((person) => person.id !== currentPerson.id);
  const needsOwnerAgreement = item.kind === "room" && otherOwner !== undefined;
  const fromShare = dialog?.kind === "share";
  const back = (toShare: boolean) => setDialog(toShare ? { kind: "share" } : null);
  const store = useItemGrantsStore.getState;
  const setVisibility = (visibility: "shared" | "private") =>
    useThreadVisibilityStore.getState().setVisibility(item.id, visibility);

  /** Non-owners other than you who posted and would lose access. */
  const postersLosingAccess = (keepIds: readonly string[]) =>
    item.repliedIds.filter(
      (id) => !item.ownerIds.includes(id) && id !== currentPerson.id && !keepIds.includes(id),
    );

  const widen = (audience: Audience) =>
    setDialog(
      needsOwnerAgreement
        ? { kind: "ask-owner", fromShare }
        : { kind: "confirm", audience, fromShare },
    );

  /** Shares show in chats and tasks as timeline events, like a renamed group chat. */
  const logShare = (with_: string) => {
    if (item.kind === "room") return;
    logTeamEvent(
      item.id,
      "share",
      `${firstName(currentPerson.name)} shared this ${item.kind} with ${with_}`,
    );
  };

  const applyShare = (audience: Audience) => {
    if (audience.kind === "team") {
      setVisibility("shared");
      notify(`Shared with ${teamName}`);
      logShare(teamName);
    } else if (audience.kind === "people") {
      store().grant(item.id, audience.ids);
      const names = joinNames(peopleByIds(audience.ids), "them");
      notify(`Shared with ${names}`);
      logShare(names);
    } else {
      store().invite(item.id, audience.email);
    }
  };

  const audienceLabel = (audience: Audience) => {
    if (audience.kind === "email") return audience.email;
    const current = new Set(peopleWithAccess(item).map((person) => person.id));
    const ids =
      audience.kind === "team" ? (teamId ? (findTeam(teamId)?.memberIds ?? []) : []) : audience.ids;
    const added = peopleByIds(ids.filter((id) => !current.has(id) && id !== currentPerson.id));
    return joinNames(added, audience.kind === "team" ? teamName : "them");
  };

  const forkPrivate = () => {
    setDialog(null);
    const forkId = forkItem({
      id: item.id,
      title: item.title,
      type: item.kind === "room" ? "room" : "thread",
    });
    notify("Forked a private copy", "Same history, only you. The original stays as it is.");
    if (item.kind === "room") {
      void navigate({ to: "/rooms/$roomId", params: { roomId: forkId } });
    } else {
      void navigate({ to: "/shared/$threadId", params: { threadId: forkId } });
    }
  };

  const confirm = dialog?.kind === "confirm" ? dialog : null;
  const fork = dialog?.kind === "fork" ? dialog : null;
  const ownerName = otherOwner ? firstName(otherOwner.name) : "the other owner";

  const dialogs = (
    <>
      <ShareDialog
        target={{ kind: "item", item }}
        open={dialog?.kind === "share"}
        onOpenChange={(open) => setDialog(open ? { kind: "share" } : null)}
        actions={{
          addPeople: (ids) => widen({ kind: "people", ids }),
          invite: (email) => widen({ kind: "email", email }),
          removePerson: (personId) => {
            const teamMembers = teamId ? (findTeam(teamId)?.memberIds ?? []) : [];
            const keepsAccess = item.visibility === "shared" && teamMembers.includes(personId);
            if (item.repliedIds.includes(personId) && !keepsAccess) {
              setDialog({ kind: "fork", posters: [personId], fromShare });
            } else {
              store().revoke(item.id, personId);
            }
          },
          setRole: (personId: string, role: ShareRole) => store().setRole(item.id, personId, role),
          setGeneral: (scope) => {
            if (scope === "team") return widen({ kind: "team" });
            const posters = postersLosingAccess(item.grantedIds);
            if (posters.length > 0) setDialog({ kind: "fork", posters, fromShare });
            else setVisibility("private");
          },
        }}
      />
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && back(!!confirm?.fromShare)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Share with {confirm ? audienceLabel(confirm.audience) : teamName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They'll see the full history, including your agents' turns, and can reply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (confirm) applyShare(confirm.audience);
                back(!!confirm?.fromShare);
              }}
            >
              Share
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={dialog?.kind === "ask-owner"}
        onOpenChange={(open) => !open && back(dialog?.kind === "ask-owner" && dialog.fromShare)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Ask {ownerName} first</AlertDialogTitle>
            <AlertDialogDescription>
              {ownerName}'s assistant shared things here under {ownerName}'s policy, for you only.
              Anyone else sees it once {ownerName} agrees.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setDialog(null);
                notify(`Asked ${ownerName} to share`, `It opens up once ${ownerName} agrees.`);
              }}
            >
              Ask {ownerName}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={fork !== null} onOpenChange={(open) => !open && back(!!fork?.fromShare)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {joinNames(peopleByIds(fork?.posters ?? []), "Others")} posted here
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their turns aren't yours to hide. Fork a private copy with the same history; this one
              stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={forkPrivate}>Fork a private copy</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );

  return {
    item,
    openShareDialog: () => setDialog({ kind: "share" }),
    requestShare: (audience) =>
      setDialog(
        needsOwnerAgreement
          ? { kind: "ask-owner", fromShare: false }
          : {
              kind: "confirm",
              audience: audience === "team" ? { kind: "team" } : { kind: "people", ids: audience },
              fromShare: false,
            },
      ),
    requestPrivate: () => {
      const posters = postersLosingAccess(item.grantedIds);
      if (posters.length > 0) setDialog({ kind: "fork", posters, fromShare: false });
      else setVisibility("private");
    },
    shareAndNotify: (people) => {
      if (needsOwnerAgreement) {
        setDialog({ kind: "ask-owner", fromShare: false });
        return;
      }
      store().grant(
        item.id,
        people.map((person) => person.id),
      );
      notify(`Shared with ${joinNames(people, "them")} and notified`);
      logShare(joinNames(people, "them"));
    },
    dialogs,
  };
}
