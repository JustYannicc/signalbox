import { toastManager } from "../ui/toast";

/** Placeholder feedback for automation actions that have no backend yet. */
export function notifyAutomationsComingSoon(action: string) {
  toastManager.add({
    id: "automations-coming-soon",
    type: "info",
    title: `${action} is coming soon`,
    description: "Automations are a preview. Nothing runs yet.",
    timeout: 2500,
  });
}
