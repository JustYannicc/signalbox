import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDrive } from "@t3tools/contracts/signalboxDrives";

/**
 * Where each drive shows under `/drives`, laid out like Google Drive in every
 * context: `/drives/<context>/My Drive`, `/drives/<context>/Shared drives/<name>`
 * and `/drives/<context>/Shared with me/<name>`. Names are made safe as path
 * segments and unique among their siblings, so two drives never share a path.
 * A folder the user split out of their own My Drive is not listed again: it
 * stays at its place in My Drive, as a shortcut.
 */

export const MY_DRIVE = "My Drive";
export const SHARED_DRIVES = "Shared drives";
export const SHARED_WITH_ME = "Shared with me";

/** A name as one path segment: no slashes or control characters, never `.` or `..`. */
export const segmentName = (name: string) => {
  const cleaned = [...name.replaceAll("/", "∕")]
    .filter((char) => char > "\u001f" && char !== "\u007f")
    .join("")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "Untitled" : cleaned;
};

/** `names` made unique in order: a repeat becomes `Name (2)`, `Name (3)`… */
export const uniqueNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
};

export interface DrivePlacement {
  readonly drive: SignalboxDrive;
  /** Its path in the context's folder; null when only a shortcut reaches it. */
  readonly path: string | null;
}

export interface ContextPlacement {
  readonly context: SignalboxContext;
  /** The context's folder under `/drives`. */
  readonly name: string;
  readonly drives: ReadonlyArray<DrivePlacement>;
}

/** Every context with its drives in sidebar order: My Drive, shared drives, then Shared with me. */
export const placeDrives = (
  contexts: ReadonlyArray<SignalboxContext>,
  drives: ReadonlyArray<SignalboxDrive>,
): ReadonlyArray<ContextPlacement> => {
  const folders = uniqueNames(contexts.map((context) => segmentName(context.name)));
  return contexts.map((context, index) => {
    const own = drives.filter((drive) => drive.contextId === context.id);
    const group = (
      prefix: string,
      members: ReadonlyArray<SignalboxDrive>,
    ): ReadonlyArray<DrivePlacement> => {
      const names = uniqueNames(members.map((drive) => segmentName(drive.name)));
      return members.map((drive, at) => ({ drive, path: `${prefix}/${names[at]!}` }));
    };
    const shared = own.filter((drive) => drive.kind === "shared");
    const sharedWithMe = own.filter((drive) => drive.kind === "folder" && drive.role !== "owner");
    return {
      context,
      name: folders[index]!,
      drives: [
        ...own
          .filter((drive) => drive.kind === "my")
          .map((drive) => ({ drive, path: MY_DRIVE as string | null })),
        ...group(SHARED_DRIVES, shared),
        ...group(SHARED_WITH_ME, sharedWithMe),
        ...own
          .filter((drive) => drive.kind === "folder" && drive.role === "owner")
          .map((drive) => ({ drive, path: null })),
      ],
    };
  });
};
