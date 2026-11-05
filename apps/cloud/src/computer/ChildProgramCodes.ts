import type { ChildWorkerCode } from "./ChildWorkerCode.ts";
import type { ChildCoreutilsCommand } from "./ChildProgramSet.ts";

export interface ChildProgramCodes {
  readonly bash: ChildWorkerCode;
  readonly busyboxCat: ChildWorkerCode;
  readonly busyboxApplets?: ChildWorkerCode;
  readonly productBusyboxApplets?: ChildWorkerCode;
  readonly ripgrep: ChildWorkerCode;
  readonly coreutils?: Partial<Readonly<Record<ChildCoreutilsCommand, ChildWorkerCode>>>;
  readonly git?: ChildWorkerCode;
  readonly sed?: ChildWorkerCode;
  readonly jq?: ChildWorkerCode;
  readonly ugrep?: ChildWorkerCode;
}
