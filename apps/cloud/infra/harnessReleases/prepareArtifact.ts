import { prepareHarnessArtifactWithFileSystem } from "./prepareArtifact.internal.ts";
import type { PrepareHarnessArtifactInput } from "./prepareArtifact.internal.ts";

export { artifactDirectorySource } from "./prepareArtifact.internal.ts";
export type { PrepareHarnessArtifactInput } from "./prepareArtifact.internal.ts";

export const prepareHarnessArtifact = (input: PrepareHarnessArtifactInput) =>
  prepareHarnessArtifactWithFileSystem(input);
