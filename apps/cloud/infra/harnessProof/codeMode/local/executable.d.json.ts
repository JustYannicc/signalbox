import type { prepareCodeModeHost } from "../prepare.ts";

type Executable = Awaited<ReturnType<typeof prepareCodeModeHost>>["executable"];
export declare const path: Executable["path"];
export declare const sha256: Executable["sha256"];
export declare const bytes: readonly number[];
