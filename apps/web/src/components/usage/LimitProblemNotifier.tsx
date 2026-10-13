import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { limitProblemsAtom } from "../../state/limitProblems";
import { environmentPresentations } from "../../state/presentation";
import { hasDesktopNotifications } from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const PERSIST_BEFORE_ANNOUNCING_MS = 30_000;

/**
 * Tells the user once when an account breaks (its login died, or a hub went
 * down): a toast while Signalbox is in front, a desktop notification
 * otherwise. Problems a hub already had on its first read are not announced;
 * the dot on Usage shows them. A problem must last a while before
 * it is announced, so a hub restarting does not page anyone. Follows the same
 * settings as thread notifications.
 */
export function LimitProblemNotifier() {
  const problems = useAtomValue(limitProblemsAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  // Problem keys per `environmentId:sourceId` from the last snapshot.
  const seen = useRef(new Map<string, ReadonlySet<string>>());
  const latest = useRef<ReadonlySet<string>>(new Set());
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const openLimits = useEffectEvent(() => {
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    void navigate({ to: "/usage" });
  });

  const announce = useEffectEvent((title: string, detail: string, tag: string) => {
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (focused && inApp) {
      const toastId = toastManager.add({
        type: "error",
        title,
        description: detail,
        data: {
          hideCopyButton: true,
          leadingIcon: (
            <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
          ),
        },
        actionProps: {
          children: "Open Limits",
          onClick: () => {
            toastManager.close(toastId);
            openLimits();
          },
        },
      });
      return;
    }
    if (
      focused ||
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const notification = new Notification(title, { body: detail, tag });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        openLimits();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  });

  useEffect(() => {
    latest.current = new Set(problems.map((problem) => problem.key));
    // A problem that cleared starts over: it must last again before it is announced.
    for (const [key, timer] of pending.current) {
      if (latest.current.has(key)) continue;
      clearTimeout(timer);
      pending.current.delete(key);
    }
    const next = new Map<string, ReadonlySet<string>>();
    for (const [environmentId, presentation] of presentations) {
      for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
        const sourceKey = `${environmentId}:${source.id}`;
        const own = problems.filter(
          (problem) => problem.environmentId === environmentId && problem.sourceId === source.id,
        );
        const previous = seen.current.get(sourceKey);
        next.set(sourceKey, new Set(own.map((problem) => problem.key)));
        // A source's first read is its baseline: whatever was already broken is not news.
        if (!previous) continue;
        for (const problem of own) {
          if (previous.has(problem.key) || pending.current.has(problem.key)) continue;
          pending.current.set(
            problem.key,
            setTimeout(() => {
              pending.current.delete(problem.key);
              if (latest.current.has(problem.key)) {
                announce(problem.title, problem.detail, problem.key);
              }
            }, PERSIST_BEFORE_ANNOUNCING_MS),
          );
        }
      }
    }
    seen.current = next;
  }, [presentations, problems]);

  useEffect(() => {
    const timers = pending.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  return null;
}
