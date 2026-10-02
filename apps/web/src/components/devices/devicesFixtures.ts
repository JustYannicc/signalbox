/**
 * PLACEHOLDER DATA. The client apps on the Devices page; nothing here comes
 * from a client. Servers and account pins live in ./fleet.ts. Delete once
 * clients register for real.
 */
import type { ClientDevice } from "./devicesModel";

export const CLIENT_DEVICES: readonly ClientDevice[] = [
  {
    id: "macbook",
    name: "MacBook Pro",
    kind: "laptop",
    os: "macOS 27",
    thisDevice: true,
    activeNow: true,
    lastSeen: "Now",
    notify: "badge",
    capabilities: [
      { id: "downloads", group: "files", label: "~/Downloads", detail: "Read", enabled: true },
      { id: "desktop", group: "files", label: "~/Desktop", detail: "Read", enabled: false },
      {
        id: "screenshot",
        group: "device",
        label: "Screenshot",
        detail: "On request",
        enabled: true,
      },
      { id: "clipboard", group: "device", label: "Clipboard", detail: "Read", enabled: false },
      {
        id: "notifications",
        group: "device",
        label: "Notifications",
        detail: "Send",
        enabled: true,
      },
      { id: "wifi", group: "signals", label: "Wi-Fi", detail: "Network name", enabled: true },
      {
        id: "nfc",
        group: "signals",
        label: "NFC",
        detail: "Tag taps",
        enabled: false,
        unavailable: "No NFC reader on this Mac",
      },
      { id: "location", group: "signals", label: "Location", detail: "Coarse", enabled: false },
      { id: "time", group: "signals", label: "Time", detail: "Local time zone", enabled: true },
    ],
  },
  {
    id: "pixel",
    name: "Pixel 8 Pro",
    kind: "phone",
    os: "Android 17",
    thisDevice: false,
    activeNow: false,
    lastSeen: "4m ago",
    notify: "urgent",
    capabilities: [
      { id: "downloads", group: "files", label: "Downloads", detail: "Read", enabled: true },
      { id: "screenshot", group: "device", label: "Screenshot", detail: "Ask", enabled: false },
      { id: "clipboard", group: "device", label: "Clipboard", detail: "Read", enabled: false },
      {
        id: "notifications",
        group: "device",
        label: "Notifications",
        detail: "Send",
        enabled: true,
      },
      { id: "wifi", group: "signals", label: "Wi-Fi", detail: "Network name", enabled: true },
      { id: "nfc", group: "signals", label: "NFC", detail: "Tag taps", enabled: true },
      { id: "location", group: "signals", label: "Location", detail: "Geofences", enabled: true },
      { id: "time", group: "signals", label: "Time", detail: "Local time zone", enabled: true },
    ],
  },
];
