/**
 * Make the assistant yours: its name and face, its SOUL.md and USER.md. Edits
 * stay a draft until Save. Its AGENTS.md is edited with every other role's in
 * Plugins › Instructions, and notification defaults live in Settings; both are
 * linked from here. The open tab is in the URL (`?customize=`).
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ASSISTANT_NAME, useAssistantIdentityState } from "./assistantIdentity";
import type { CustomizeTab } from "./assistantModel";
import {
  DEFAULT_USER_MD,
  defaultSoulMd,
  useAssistantSoulState,
  useAssistantUserState,
} from "./assistantSoul";
import { AssistantAvatarPicker, DEFAULT_ASSISTANT_AVATAR, useAssistantAvatar } from "./avatar";
import { MarkdownEditor } from "./MarkdownDoc";

export type CustomizeDialogTab = Exclude<CustomizeTab, "notifications">;

const TABS: readonly { value: CustomizeDialogTab; label: string }[] = [
  { value: "identity", label: "Identity" },
  { value: "soul", label: "Soul" },
  { value: "about", label: "About you" },
];

function CustomizeForm(props: {
  tab: CustomizeDialogTab;
  onTabChange: (tab: CustomizeDialogTab) => void;
  onDone: () => void;
}) {
  const { tab } = props;
  const [identity, setIdentity] = useAssistantIdentityState();
  const [avatar, setAvatar] = useAssistantAvatar();
  const [soul, setSoul] = useAssistantSoulState();
  const [user, setUser] = useAssistantUserState();
  const [draft, setDraft] = useState({ name: identity.name, avatar, soul, user });
  const name = draft.name.trim() || ASSISTANT_NAME;
  const patch = (next: Partial<typeof draft>) => setDraft((prev) => ({ ...prev, ...next }));
  const tabLabel = TABS.find((option) => option.value === tab)?.label ?? "";
  const resetTab = () =>
    patch(
      tab === "identity"
        ? { name: ASSISTANT_NAME, avatar: DEFAULT_ASSISTANT_AVATAR }
        : tab === "soul"
          ? { soul: defaultSoulMd(name) }
          : { user: DEFAULT_USER_MD },
    );

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        setIdentity({ name });
        setAvatar(draft.avatar);
        // An untouched default keeps following the name, even across a rename.
        const soulIsDefault =
          draft.soul === defaultSoulMd(identity.name) || draft.soul === defaultSoulMd(name);
        setSoul(soulIsDefault ? null : draft.soul);
        setUser(draft.user);
        toastManager.add({ type: "success", title: `Saved ${name}`, timeout: 2000 });
        props.onDone();
      }}
    >
      <DialogHeader>
        <DialogTitle>Customize {name}</DialogTitle>
        <DialogDescription>
          {name} reads its soul and what it knows about you at the start of every chat.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ToggleGroup
          aria-label="Section"
          value={[tab]}
          onValueChange={(next) => {
            const value = TABS.find((option) => option.value === next[0]);
            if (value) props.onTabChange(value.value);
          }}
        >
          {TABS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>

        {tab === "identity" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assistant-name">Name</Label>
              <Input
                id="assistant-name"
                value={draft.name}
                maxLength={24}
                placeholder={ASSISTANT_NAME}
                onChange={(event) => patch({ name: event.currentTarget.value })}
              />
            </div>
            <AssistantAvatarPicker
              value={draft.avatar}
              onChange={(next) => patch({ avatar: next })}
              name={name}
            />
          </div>
        ) : tab === "soul" ? (
          <MarkdownEditor
            label="SOUL.md"
            note="Personality, tone, values and limits."
            value={draft.soul}
            onChange={(next) => patch({ soul: next })}
          />
        ) : (
          <MarkdownEditor
            label="USER.md"
            note={`What ${name} knows about you.`}
            value={draft.user}
            onChange={(next) => patch({ user: next })}
          />
        )}

        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
          <span>Also:</span>
          <Button
            size="xs"
            variant="ghost-muted"
            render={
              <Link
                to="/plugins"
                search={{ section: "instructions", role: "assistant", scope: "personal" }}
              />
            }
          >
            AGENTS.md in Plugins
            <ArrowUpRightIcon />
          </Button>
          <Button size="xs" variant="ghost-muted" render={<Link to="/settings/notifications" />}>
            Notifications in Settings
            <ArrowUpRightIcon />
          </Button>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={resetTab}>
          Reset {tabLabel}
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

export function AssistantCustomizeDialog(props: {
  /** Open on this tab; null when closed. */
  tab: CustomizeDialogTab | null;
  onTabChange: (tab: CustomizeDialogTab | null) => void;
}) {
  const open = props.tab !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => props.onTabChange(next ? "identity" : null)}>
      <DialogPopup className="max-w-xl">
        {/* Remount per open so every visit starts from what is saved. */}
        <CustomizeForm
          key={String(open)}
          tab={props.tab ?? "identity"}
          onTabChange={props.onTabChange}
          onDone={() => props.onTabChange(null)}
        />
      </DialogPopup>
    </Dialog>
  );
}
