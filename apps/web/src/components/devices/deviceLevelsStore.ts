/**
 * Where each client device sits in Home, as you moved it on the Devices page.
 * PLACEHOLDER: prototype state over `CLIENT_DEVICES`. Read devices with
 * `useClientDevices()` in React and `clientDevices()` outside it (delivery,
 * escalation), so both see the same levels.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import type { LevelKey, Reach } from "../levels/levels";
import { CLIENT_DEVICES } from "./devicesFixtures";
import type { ClientDevice } from "./devicesModel";

interface DeviceLevelsState {
  levels: Record<string, LevelKey>;
  reach: Record<string, Reach>;
  setLevel: (deviceId: string, level: LevelKey) => void;
  setReach: (deviceId: string, reach: Reach) => void;
}

export const useDeviceLevelsStore = create<DeviceLevelsState>()(
  persist(
    (set) => ({
      levels: {},
      reach: {},
      setLevel: (deviceId, level) =>
        set((state) => ({ levels: { ...state.levels, [deviceId]: level } })),
      setReach: (deviceId, reach) =>
        set((state) => ({ reach: { ...state.reach, [deviceId]: reach } })),
    }),
    { name: "t3code:devices:levels:v1", version: 1, storage: prototypeStorage() },
  ),
);

function placed(
  levels: DeviceLevelsState["levels"],
  reach: DeviceLevelsState["reach"],
): readonly ClientDevice[] {
  return CLIENT_DEVICES.map((device) => {
    const nextReach = reach[device.id] ?? device.reach;
    return {
      ...device,
      level: levels[device.id] ?? device.level,
      ...(nextReach ? { reach: nextReach } : {}),
    };
  });
}

/** The client devices with your moves applied, outside React. */
export function clientDevices(): readonly ClientDevice[] {
  const { levels, reach } = useDeviceLevelsStore.getState();
  return placed(levels, reach);
}

export function useClientDevices(): readonly ClientDevice[] {
  const levels = useDeviceLevelsStore((state) => state.levels);
  const reach = useDeviceLevelsStore((state) => state.reach);
  return useMemo(() => placed(levels, reach), [levels, reach]);
}
