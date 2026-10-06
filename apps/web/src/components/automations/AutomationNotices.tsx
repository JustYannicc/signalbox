/**
 * Tells the user what automations want from them. ThreadNotificationCoordinator
 * mounts one listener per environment beside its own, so automation alerts
 * share its gating, dock badge and close-on-focus: a toast while the app has
 * focus, a desktop notification otherwise, and a sound. Questions (`w.ask`)
 * use the input sound and stay a warning; failed runs show as errors;
 * `w.notify` messages follow their importance, and low ones stay silent.
 * Notices are live only, so nothing from before the app opened shows up again.
 */
import { useAtomValue } from "@effect/atom-react";
import { automationKey } from "@t3tools/client-runtime/automations/list";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { AutomationNotice, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { BellIcon, CircleAlertIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect } from "react";

import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { automationState } from "../../state/automations";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { automationRoute } from "./automationFormat";

/** Notices already shown in this tab, so a remount or reconnect never repeats one. Oldest go first. */
const announced = new Set<string>();
const ANNOUNCED_LIMIT = 500;

function firstAnnouncement(key: string): boolean {
  if (announced.has(key)) return false;
  announced.add(key);
  if (announced.size > ANNOUNCED_LIMIT) {
    announced.delete(announced.values().next().value!);
  }
  return true;
}

type OnNotification = (environmentId: EnvironmentId, notification: Notification) => void;

/** One environment's automation alerts, while it's connected. */
export function AutomationNotices(props: {
  environmentId: EnvironmentId;
  /** Counts the desktop notification on the dock badge and closes it when the app gets focus. */
  onNotification: OnNotification;
}) {
  const connected = useConnectedEnvironmentIds();
  if (!connected.includes(props.environmentId)) return null;
  return <NoticeListener {...props} />;
}

function NoticeListener(props: { environmentId: EnvironmentId; onNotification: OnNotification }) {
  const { environmentId, onNotification } = props;
  const result = useAtomValue(automationState.notices({ environmentId, input: {} }));
  const notices = Option.getOrNull(AsyncResult.value(result));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  const openAutomationId = useParams({
    strict: false,
    select: (params) => ("automationId" in params ? (params.automationId ?? null) : null),
  });

  useEffect(() => {
    for (const notice of notices ?? []) {
      if (!firstAnnouncement(automationKey(environmentId, notice.id))) continue;
      if (notice.importance === "low") continue;
      present(notice, {
        open: () =>
          void navigate(
            automationRoute({ environmentId, automationId: notice.automationId }, notice.runId),
          ),
        onScreen: openAutomationId === notice.automationId,
        mode,
        inApp,
        onNotification: (notification) => onNotification(environmentId, notification),
      });
    }
  }, [environmentId, inApp, mode, navigate, notices, onNotification, openAutomationId]);

  return null;
}

function present(
  notice: AutomationNotice,
  options: {
    open: () => void;
    onScreen: boolean;
    mode: ReturnType<typeof getClientSettings>["notificationMode"];
    inApp: boolean;
    onNotification: (notification: Notification) => void;
  },
) {
  const asking = notice.kind === "ask";
  const failed = notice.kind === "failed";
  const title = asking
    ? `${notice.title} needs you`
    : failed
      ? `${notice.title} failed`
      : notice.title;
  if (hasNotificationSound(options.mode)) {
    void playNotificationSound(asking ? "input" : "completion", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (focused) {
    if (!options.inApp || options.onScreen) return;
    const toastId = toastManager.add({
      type: failed ? "error" : asking || notice.importance === "high" ? "warning" : "info",
      title,
      description: notice.body,
      data: {
        hideCopyButton: true,
        leadingIcon: asking ? (
          <MessageCircleQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
        ) : failed ? (
          <CircleAlertIcon aria-hidden className="size-4 text-destructive" />
        ) : (
          <BellIcon aria-hidden className="size-4" />
        ),
      },
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(toastId);
          options.open();
        },
      },
    });
    return;
  }
  if (
    !hasDesktopNotifications(options.mode) ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  try {
    const notification = new Notification(title, {
      body: notice.body,
      tag: `automation:${notice.id}`,
      silent: true,
    });
    options.onNotification(notification);
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      options.open();
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
  }
}
