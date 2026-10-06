import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  Automation,
  AutomationRetryVersion,
  AutomationRunSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { automationState } from "../../state/automations";
import { useAtomCommand } from "../../state/use-atom-command";

/** Hooks the automation screens share: starting, stopping and retrying runs, pausing, and a ticking clock. */

/** Starts a run, optionally with a past run's input, and opens it. Reports its own failure. */
export function useStartRun(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const runNow = useAtomCommand(automationState.runNow, {
    label: "automation run now",
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (automationId: Automation["id"], input?: unknown) => {
      setStarting(true);
      void Haptics.selectionAsync();
      const result = await runNow({
        environmentId,
        input: { automationId, ...(input === undefined || input === null ? {} : { input }) },
      });
      setStarting(false);
      if (result._tag === "Success") {
        navigation.dispatch(
          StackActions.push("AutomationRun", { environmentId, runId: result.value.id }),
        );
      } else if (!isAtomCommandInterrupted(result)) {
        Alert.alert("Couldn't start a run", String(squashAtomCommandFailure(result)));
      }
    },
    [environmentId, navigation, runNow],
  );
  return { starting, start };
}

/**
 * Retries a failed or cancelled run as a new run that reuses the steps that
 * went well, and opens it. When a newer version is live it asks which to use.
 */
export function useRetryRun(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const retryRun = useAtomCommand(automationState.retryRun, {
    label: "automation retry run",
    reportFailure: false,
  });
  const [retrying, setRetrying] = useState(false);
  const send = useCallback(
    async (runId: string, version: AutomationRetryVersion) => {
      setRetrying(true);
      void Haptics.selectionAsync();
      const result = await retryRun({ environmentId, input: { runId, version } });
      setRetrying(false);
      if (result._tag === "Success") {
        navigation.dispatch(
          StackActions.push("AutomationRun", { environmentId, runId: result.value.id }),
        );
      } else if (!isAtomCommandInterrupted(result)) {
        Alert.alert("Couldn't retry the run", String(squashAtomCommandFailure(result)));
      }
    },
    [environmentId, navigation, retryRun],
  );
  const retry = useCallback(
    (run: Pick<AutomationRunSummary, "id" | "version">, latestVersion: number | null) => {
      if (latestVersion === null || latestVersion <= run.version) {
        void send(run.id, "same");
        return;
      }
      Alert.alert("Retry on which version?", "Steps that went well are reused either way.", [
        { text: "Cancel", style: "cancel" },
        { text: `This run's (${run.version})`, onPress: () => void send(run.id, "same") },
        { text: `Latest (${latestVersion})`, onPress: () => void send(run.id, "latest") },
      ]);
    },
    [send],
  );
  return { retrying, retry };
}

/** Asks, then stops a running run. Steps already done stay done. */
export function useStopRun(environmentId: EnvironmentId, runId: string) {
  const cancelRun = useAtomCommand(automationState.cancelRun, {
    label: "automation cancel run",
    reportFailure: false,
  });
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(
    () =>
      Alert.alert("Stop this run?", "Steps already done stay done.", [
        { text: "Keep running", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: async () => {
            setStopping(true);
            const result = await cancelRun({ environmentId, input: { runId } });
            setStopping(false);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              Alert.alert("Couldn't stop the run", String(squashAtomCommandFailure(result)));
            }
          },
        },
      ]),
    [cancelRun, environmentId, runId],
  );
  return { stopping, stop };
}

/** On/Off with the switch following your tap until the live list catches up. */
export function useEnabledToggle(environmentId: EnvironmentId, automation: Automation) {
  const setEnabled = useAtomCommand(automationState.setEnabled, {
    label: "automation enabled",
    reportFailure: false,
  });
  const [pending, setPending] = useState<boolean | null>(null);
  const set = async (enabled: boolean) => {
    setPending(enabled);
    const result = await setEnabled({
      environmentId,
      input: { automationId: automation.id, enabled },
    });
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert(
        enabled ? "Couldn't turn it on" : "Couldn't pause it",
        String(squashAtomCommandFailure(result)),
      );
    }
  };
  return { value: pending ?? automation.enabled, set: (enabled: boolean) => void set(enabled) };
}

/** The current time, ticking each minute while the screen is in front. */
export function useMinuteClock() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  return now;
}
