/**
 * PLACEHOLDER data for the capture prototype. Nothing here is persisted or
 * sent anywhere; it only exists so the UI has realistic content to render.
 * A capture is text plus optional file or link chips; the default capture
 * workflow decides what it is. `{assistant}` in a label is replaced with the
 * user's assistant name at render time.
 */

export type CaptureSource = "Mac hotkey" | "Android tile" | "Recording clip" | "In app";

export type CaptureStatus =
  | { readonly state: "pending"; readonly label: string }
  | { readonly state: "handled"; readonly label: string }
  | { readonly state: "done"; readonly label: string };

export interface CaptureAttachment {
  readonly kind: "file" | "link";
  readonly label: string;
}

export interface CaptureItem {
  readonly id: string;
  readonly text: string;
  readonly attachment?: CaptureAttachment;
  readonly capturedAt: string;
  readonly source: CaptureSource;
  readonly status: CaptureStatus;
}

/** Several captures taken minutes apart that the workflow treats as one thing. */
export interface CaptureGroup {
  readonly id: string;
  readonly summary: string;
  readonly outcome: string;
  readonly captures: ReadonlyArray<CaptureItem>;
}

export type RecentCaptureEntry =
  | { readonly type: "single"; readonly capture: CaptureItem }
  | { readonly type: "group"; readonly group: CaptureGroup };

export function withAssistantName(label: string, assistantName: string): string {
  return label.replaceAll("{assistant}", assistantName);
}

const walkingClips: ReadonlyArray<CaptureItem> = [
  {
    id: "clip-1",
    text: "Onboarding should skip the provider picker when only one CLI is installed",
    attachment: { kind: "file", label: "voice-note-0802.m4a" },
    capturedAt: "8:02",
    source: "Recording clip",
    status: { state: "handled", label: "Merged" },
  },
  {
    id: "clip-2",
    text: "…and the empty state could show the pairing QR right away",
    attachment: { kind: "file", label: "voice-note-0807.m4a" },
    capturedAt: "8:07",
    source: "Recording clip",
    status: { state: "handled", label: "Merged" },
  },
  {
    id: "clip-3",
    text: "Same thing on mobile, first launch goes straight to pairing",
    attachment: { kind: "file", label: "voice-note-0814.m4a" },
    capturedAt: "8:14",
    source: "Recording clip",
    status: { state: "handled", label: "Merged" },
  },
];

export const RECENT_CAPTURES: ReadonlyArray<RecentCaptureEntry> = [
  {
    type: "single",
    capture: {
      id: "capture-clip-talk",
      text: "The part about logs as the source of truth",
      attachment: { kind: "link", label: "youtube.com · video" },
      capturedAt: "9:41",
      source: "Mac hotkey",
      status: { state: "pending", label: "With {assistant} · transcribing" },
    },
  },
  {
    type: "single",
    capture: {
      id: "capture-reply",
      text: "Reply to Marco: yes for Thursday",
      capturedAt: "9:12",
      source: "Android tile",
      status: { state: "done", label: "Done by {assistant} · reply sent" },
    },
  },
  {
    type: "group",
    group: {
      id: "group-onboarding",
      summary: "3 captures in 12 min · likely related",
      outcome: "Merged into one note → filed to Signalbox",
      captures: walkingClips,
    },
  },
  {
    type: "single",
    capture: {
      id: "capture-skydiving",
      text: "I should go skydiving one day",
      capturedAt: "Yesterday",
      source: "Android tile",
      status: { state: "handled", label: "Filed by {assistant} → Personal" },
    },
  },
  {
    type: "single",
    capture: {
      id: "capture-link",
      text: "Read this before the migration",
      attachment: { kind: "link", label: "effect.website · link" },
      capturedAt: "Yesterday",
      source: "Mac hotkey",
      status: { state: "handled", label: "Saved to Spaces · Reading list" },
    },
  },
];

export interface CaptureDeviceSetting {
  readonly id: "hotkey" | "android-tile" | "recording-clip";
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly action: string;
}

/** Devices other than the in-app hotkey, which comes from the `capture.open` keybinding. */
export const CAPTURE_DEVICES: ReadonlyArray<CaptureDeviceSetting> = [
  {
    id: "android-tile",
    label: "Android quick settings tile",
    value: "Installed on Pixel 8 Pro",
    detail: "Pull down the shade and tap New. Works from the lock screen.",
    action: "Manage",
  },
  {
    id: "recording-clip",
    label: "Recording clip (open SDK)",
    value: "Connected",
    detail: "Press the clip to record. Recordings arrive as voice-note files.",
    action: "Disconnect",
  },
];
