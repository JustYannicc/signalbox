import { AuthFilesystemReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useEffectEvent } from "react";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentSupports, useEnvironmentSupports } from "~/state/environmentCapabilities";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

export interface CloudTerminalWorkspaceLink {
  readonly path: string;
  readonly line?: number;
}

export type CloudTerminalFileLinkAction =
  | { readonly kind: "blocked" }
  | { readonly kind: "open"; readonly target: CloudTerminalWorkspaceLink };

/** Paths outside the workspace cannot be opened in the cloud Files panel. */
export function resolveCloudTerminalWorkspaceLink(
  text: string,
  cwd: string,
  workspaceRoot: string,
): CloudTerminalWorkspaceLink | null {
  const { path, line } = splitFilePathPosition(text);
  if (path.startsWith("~")) return null;

  const segments: string[] = [];
  const joined = isAbsolutePath(path) ? path : `${cwd}/${path}`;
  for (const segment of joined.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }

  const relativePath = workspaceRelativeFilePath(`/${segments.join("/")}`, workspaceRoot);
  if (relativePath === null) return null;
  return line === undefined ? { path: relativePath } : { path: relativePath, line };
}

export function resolveCloudTerminalFileLinkAction(
  text: string,
  cwd: string,
  workspaceRoot: string,
  canReadFiles: boolean,
): CloudTerminalFileLinkAction {
  const target = canReadFiles ? resolveCloudTerminalWorkspaceLink(text, cwd, workspaceRoot) : null;
  return target === null ? { kind: "blocked" } : { kind: "open", target };
}

export function useSignalboxTerminalLinks(options: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly workspaceRoot: string;
}): {
  readonly hasLocalFilesystem: boolean;
  readonly canReadFiles: boolean;
  readonly canActivatePathLink: (text: string) => boolean | null;
  readonly handlePathLink: (text: string) => boolean;
} {
  const { environmentId, threadRef, cwd, workspaceRoot } = options;
  const hasLocalFilesystem = useEnvironmentSupports(environmentId, "localFilesystem");
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);

  const readCloudAction = (text: string): CloudTerminalFileLinkAction | null => {
    if (readEnvironmentSupports(environmentId, "localFilesystem")) return null;
    return resolveCloudTerminalFileLinkAction(
      text,
      cwd,
      workspaceRoot,
      readEnvironmentScope(environmentId, AuthFilesystemReadScope),
    );
  };

  const canActivatePathLink = useEffectEvent((text: string): boolean | null => {
    const action = readCloudAction(text);
    if (action === null) return null;
    return action.kind === "open";
  });

  const handlePathLink = useEffectEvent((text: string): boolean => {
    const action = readCloudAction(text);
    if (action === null) return false;
    if (action.kind === "open") {
      useRightPanelStore.getState().openFile(threadRef, action.target.path, action.target.line);
    }
    return true;
  });

  return { hasLocalFilesystem, canReadFiles, canActivatePathLink, handlePathLink };
}
