import {
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";

import { FORM_SHEET_PRESENTATION_OPTIONS } from "../../native/sheet-surface";
import { SettingsConnectedServicesRouteScreen } from "../settings/SettingsConnectedServicesRouteScreen";
import { AutomationRouteScreen } from "./AutomationRouteScreen";
import { AutomationRunRouteScreen } from "./AutomationRunRouteScreen";
import { AutomationRunStepSheet } from "./AutomationRunStepSheet";
import { AutomationsRouteScreen } from "./AutomationsRouteScreen";

/** Overlay routes, so a sheet over a run doesn't change the workspace beneath it. */
export const AUTOMATION_OVERLAY_ROUTES = ["AutomationRunStep"] as const;

/**
 * Root-stack routes for Automations. They are workspace destinations, flat in
 * the root stack like Thread, so a run can push the thread an agent step ran in
 * and back returns to the run. Stack.tsx passes its header presets in.
 */
export function automationStackScreens(headers: {
  /** Glass header over a scroll view. */
  readonly glass: NativeStackNavigationOptions;
  /** Opaque header for a surface that isn't a scroll view (the pannable diagram). */
  readonly solid: NativeStackNavigationOptions;
}) {
  return {
    Automations: createNativeStackScreen({
      screen: AutomationsRouteScreen,
      linking: "automations",
      options: { ...headers.glass, title: "Automations" },
    }),
    Automation: createNativeStackScreen({
      screen: AutomationRouteScreen,
      linking: "automations/:environmentId/:automationId",
      options: { ...headers.glass, title: "" },
    }),
    AutomationRun: createNativeStackScreen({
      screen: AutomationRunRouteScreen,
      linking: "automations/:environmentId/runs/:runId",
      options: { ...headers.solid, title: "" },
    }),
    AutomationRunStep: createNativeStackScreen({
      screen: AutomationRunStepSheet,
      linking: "automations/:environmentId/runs/:runId/steps/:nodeId",
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        headerShown: false,
        gestureEnabled: true,
        sheetAllowedDetents: [0.5, 0.92],
        sheetGrabberVisible: true,
      },
    }),
  };
}

/** Settings-sheet routes for Automations: the services `w.call` can reach. */
export function automationSettingsScreens() {
  return {
    SettingsConnectedServices: createNativeStackScreen({
      screen: SettingsConnectedServicesRouteScreen,
      linking: "connected-services",
      options: { title: "Connected services" },
    }),
  };
}
