import type { playerConfig } from "@rrweb/replay";
import { EventType, IncrementalSource } from "@rrweb/types";

type ReplayPlugin = NonNullable<playerConfig["plugins"]>[number];

interface Serialized {
  readonly rr_type?: unknown;
  readonly args?: unknown;
  readonly data?: unknown;
  readonly type?: unknown;
  readonly base64?: unknown;
}

const asSerialized = (value: unknown): Serialized | null =>
  typeof value === "object" && value !== null ? (value as Serialized) : null;

/** The frame a sampled canvas recorded: an image blob drawn over a cleared canvas. */
function sampledFrame(commands: unknown): { base64: string; type: string; at: number[] } | null {
  if (!Array.isArray(commands)) return null;
  for (const command of commands) {
    const entry = asSerialized(command) as { property?: unknown; args?: unknown } | null;
    if (entry?.property !== "drawImage" || !Array.isArray(entry.args)) continue;
    const [image, ...at] = entry.args as unknown[];
    const bitmap = asSerialized(image);
    const blob = Array.isArray(bitmap?.args) ? asSerialized(bitmap.args[0]) : null;
    const buffer = Array.isArray(blob?.data) ? asSerialized(blob.data[0]) : null;
    if (
      bitmap?.rr_type !== "ImageBitmap" ||
      blob?.rr_type !== "Blob" ||
      typeof buffer?.base64 !== "string" ||
      !at.every((value) => typeof value === "number")
    )
      continue;
    return {
      base64: buffer.base64,
      type: typeof blob.type === "string" ? blob.type : "image/webp",
      at: at as number[],
    };
  }
  return null;
}

/**
 * Draws the recorder's sampled canvas frames. rrweb only replays canvases when
 * the replay frame may run scripts, which this mirror never allows; drawing
 * from here needs no scripts in the frame.
 */
export function sampledCanvasPlugin(): ReplayPlugin {
  const latest = new WeakMap<object, number>();
  let sequence = 0;
  return {
    handler(event, _isSync, { replayer }) {
      if (event.type !== EventType.IncrementalSnapshot) return;
      if (event.data.source !== IncrementalSource.CanvasMutation) return;
      const data = event.data as { id: number; commands?: unknown };
      const frame = sampledFrame(data.commands);
      const canvas = replayer.getMirror().getNode(data.id);
      // The canvas lives in the replay frame's realm, so `instanceof` can't recognize it.
      if (!frame || !canvas || canvas.nodeName !== "CANVAS") return;
      const element = canvas as HTMLCanvasElement;
      const order = ++sequence;
      latest.set(element, order);
      const bytes = Uint8Array.from(atob(frame.base64), (char) => char.charCodeAt(0));
      void createImageBitmap(new Blob([bytes], { type: frame.type }))
        .then((bitmap) => {
          // A slower decode must not paint over a newer frame.
          if (latest.get(element) !== order) return bitmap.close();
          const context = element.getContext("2d");
          if (context) {
            context.clearRect(0, 0, element.width, element.height);
            const [x = 0, y = 0, ...size] = frame.at;
            if (size.length >= 2) context.drawImage(bitmap, x, y, size[0]!, size[1]!);
            else context.drawImage(bitmap, x, y);
          }
          bitmap.close();
        })
        .catch(() => undefined);
    },
  };
}
