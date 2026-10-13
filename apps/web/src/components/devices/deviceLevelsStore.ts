/**
 * Where each client device sits in Home and what it takes, as you set it on
 * the Devices page or in Settings › Notifications. PLACEHOLDER: prototype
 * state over `CLIENT_DEVICES`. Read devices with `useClientDevices()` in React
 * and `clientDevices()` outside it (delivery, escalation), so both see the
 * same levels and settings.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import type { LevelKey, Reach } from "../levels/levels";
import { CLIENT_DEVICES } from "./devicesFixtures";
import type { ClientDevice, DeviceNotifyLevel } from "./devicesModel";

interface DeviceLevelsState {
  levels: Record<string, LevelKey>;
  reach: Record<string, Reach>;
  notify: Record<string, DeviceNotifyLevel>;
  setLevel: (deviceId: string, level: LevelKey) => void;
  setReach: (deviceId: string, reach: Reach) => void;
  setNotify: (deviceId: string, notify: DeviceNotifyLevel) => void;
}

export const useDeviceLevelsStore = create<DeviceLevelsState>()(
  persist(
    (set) => ({
      levels: {},
      reach: {},
      notify: {},
      setLevel: (deviceId, level) =>
        set((state) => ({ levels: { ...state.levels, [deviceId]: level } })),
      setReach: (deviceId, reach) =>
        set((state) => ({ reach: { ...state.reach, [deviceId]: reach } })),
      setNotify: (deviceId, notify) =>
        set((state) => ({ notify: { ...state.notify, [deviceId]: notify } })),
    }),
    { name: "t3code:devices:levels:v1", version: 1, storage: prototypeStorage() },
  ),
);

type Moves = Pick<DeviceLevelsState, "levels" | "reach" | "notify">;

function placed({ levels, reach, notify }: Moves): readonly ClientDevice[] {
  return CLIENT_DEVICES.map((device) => {
    const nextReach = reach[device.id] ?? device.reach;
    return {
      ...device,
      level: levels[device.id] ?? device.level,
      notify: notify[device.id] ?? device.notify,
      ...(nextReach ? { reach: nextReach } : {}),
    };
  });
}

/** The client devices with your moves applied, outside React. */
export function clientDevices(): readonly ClientDevice[] {
  return placed(useDeviceLevelsStore.getState());
}

export function useClientDevices(): readonly ClientDevice[] {
  const levels = useDeviceLevelsStore((state) => state.levels);
  const reach = useDeviceLevelsStore((state) => state.reach);
  const notify = useDeviceLevelsStore((state) => state.notify);
  return useMemo(() => placed({ levels, reach, notify }), [levels, notify, reach]);
}
