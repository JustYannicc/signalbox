import {
  previewOpenFailureMessage,
  previewPortLabel,
} from "@t3tools/client-runtime/state/signalboxPreviews";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SignalboxPreviewPort } from "@t3tools/contracts/signalboxPreviews";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import { memo, useCallback, useRef } from "react";

import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { signalboxPreviews, useThreadPreviewPorts } from "~/state/signalboxPreviews";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const OPENS_IN = isElectron ? "in your browser" : "in a new tab";

function previewTitle(port: SignalboxPreviewPort) {
  return `Open ${port.processName ?? "the dev server"} on port ${port.port} ${OPENS_IN}`;
}

/**
 * Opens a fresh link to one of the thread's previews. The web build
 * reserves the tab inside the click, since browsers block tabs opened after
 * an await; desktop hands the link to the system browser.
 */
function useOpenThreadPreview(environmentId: EnvironmentId, threadId: ThreadId) {
  const open = useAtomCommand(signalboxPreviews.open, { reportFailure: false });
  const opening = useRef(false);
  return useCallback(
    (port: number) => {
      if (opening.current) return;
      const toastFailure = (description: string) =>
        toastManager.add({ type: "error", title: `Couldn't open preview :${port}`, description });
      const pending = isElectron ? null : window.open("", "_blank");
      if (!isElectron && pending === null) {
        // A blocked tab stays blocked after the await, so there's nothing to fall back to.
        toastFailure(
          "Your browser blocked the new tab. Allow pop-ups for this site and try again.",
        );
        return;
      }
      if (pending) pending.opener = null;
      opening.current = true;
      const fail = (error: unknown) => {
        pending?.close();
        toastFailure(previewOpenFailureMessage(error));
      };
      void open({ environmentId, input: { threadId, port } })
        .then(async (result) => {
          if (isAtomCommandInterrupted(result)) {
            pending?.close();
            return;
          }
          if (result._tag === "Failure") return fail(squashAtomCommandFailure(result));
          // Without a reserved tab this is desktop, which hands the link to the system browser.
          if (pending) pending.location.href = result.value.url;
          else await ensureLocalApi().shell.openExternal(result.value.url);
        })
        .catch(fail)
        .finally(() => {
          opening.current = false;
        });
    },
    [environmentId, open, threadId],
  );
}

/**
 * The thread's running dev servers, in the chat header. Shows up only when the
 * thread's Signalbox Cloud machine serves one: appearing is the notification.
 */
export const ThreadPreviewsControl = memo(function ThreadPreviewsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ports = useThreadPreviewPorts(props.environmentId, props.threadId);
  const canOpen = useAtomValue(signalboxPreviews.open.permissionAtom(props.environmentId));
  const openPreview = useOpenThreadPreview(props.environmentId, props.threadId);
  const [first] = ports;
  if (first === undefined || !canOpen) return null;

  if (ports.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost-muted" size="xs" onClick={() => openPreview(first.port)} />
          }
        >
          <GlobeIcon aria-hidden />
          <span className="max-sm:sr-only">Preview</span>
          <span className="tabular-nums">{previewPortLabel(first)}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{previewTitle(first)}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" />}>
        <GlobeIcon aria-hidden />
        <span className="max-sm:sr-only">Previews</span>
        <span className="tabular-nums sm:hidden">{ports.length}</span>
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Open {OPENS_IN}</MenuGroupLabel>
          {ports.map((port) => (
            <MenuItem key={port.port} onClick={() => openPreview(port.port)}>
              <span className="tabular-nums">{previewPortLabel(port)}</span>
              {port.processName ? (
                <span className="ms-auto min-w-0 truncate ps-4 text-muted-foreground text-xs">
                  {port.processName}
                </span>
              ) : null}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
