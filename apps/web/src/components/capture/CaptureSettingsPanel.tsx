/**
 * Capture settings: the default capture workflow (editable, never removable)
 * and the ways to open New outside the app window. The hotkey is the real
 * `capture.open` keybinding; the other devices are PLACEHOLDERS.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { KeyboardIcon, MicIcon, SmartphoneIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { AssistantIcon, useAssistantIdentity } from "../assistant/assistantIdentity";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { CAPTURE_DEVICES, type CaptureDeviceSetting } from "./captureFixtures";

const DEVICE_ICONS: Record<CaptureDeviceSetting["id"], LucideIcon> = {
  hotkey: KeyboardIcon,
  "android-tile": SmartphoneIcon,
  "recording-clip": MicIcon,
};

function notifyPreview(action: string) {
  toastManager.add({
    id: "capture-settings-preview",
    type: "info",
    title: `${action} is a preview`,
    description: "Capture devices are placeholders. Nothing changes yet.",
    timeout: 2500,
  });
}

function SettingRow(props: {
  icon: ReactNode;
  label: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">{props.children}</span>
    </li>
  );
}

export function CaptureSettingsPanel() {
  const navigate = useNavigate();
  const assistant = useAssistantIdentity();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hotkey = shortcutLabelForCommand(keybindings, "capture.open");
  const HotkeyIcon = DEVICE_ICONS.hotkey;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="capture-workflow" className="flex flex-col gap-2">
        <h2 id="capture-workflow" className="text-sm font-medium text-foreground">
          Where captures go
        </h2>
        <ul className="flex flex-col rounded-xl border">
          <SettingRow
            icon={<AssistantIcon />}
            label="Default capture workflow"
            detail={`Every capture goes to today's ${assistant.name} chat. ${assistant.name} files it, merges related ones, or just does quick tasks. #tags and @mentions are hints it follows. Captures stay private unless you add +someone or tag a shared project.`}
          >
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/automations/$automationId",
                  params: { automationId: "capture-routing" },
                })
              }
            >
              Edit workflow
            </Button>
          </SettingRow>
        </ul>
      </section>

      <section aria-labelledby="capture-devices" className="flex flex-col gap-2">
        <h2 id="capture-devices" className="text-sm font-medium text-foreground">
          Open New from anywhere
        </h2>
        <ul className="flex flex-col divide-y rounded-xl border">
          <SettingRow
            icon={<HotkeyIcon aria-hidden className="size-4" />}
            label="Hotkey"
            detail="Opens New anywhere in the app."
          >
            {hotkey ? (
              <Kbd>{hotkey}</Kbd>
            ) : (
              <span className="text-xs text-muted-foreground">Not set</span>
            )}
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void navigate({ to: "/settings/keybindings" })}
            >
              Change
            </Button>
          </SettingRow>
          {CAPTURE_DEVICES.map((device) => {
            const Icon = DEVICE_ICONS[device.id];
            return (
              <SettingRow
                key={device.id}
                icon={<Icon aria-hidden className="size-4" />}
                label={device.label}
                detail={device.detail}
              >
                <span className="text-xs text-muted-foreground">{device.value}</span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => notifyPreview(device.action)}
                >
                  {device.action}
                </Button>
              </SettingRow>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
