import type { AuthCallback } from "isomorphic-git";
import type { KernelAsyncProgram } from "../../../kernel/KernelAsyncProgram.ts";

export interface NodeGitProgramOptions {
  /** The existing Git implementation receives every command outside the JS HTTP subset. */
  readonly local: KernelAsyncProgram;
  /** Caller-owned credentials. No environment or host credential lookup is performed. */
  readonly onAuth?: AuthCallback;
  /** Allows deterministic smart-HTTP fixtures while production uses the Workers Fetch API. */
  readonly fetch?: typeof globalThis.fetch;
}

export type NodeGitRoute =
  | { readonly kind: "local" }
  | { readonly kind: "reject"; readonly exitCode: number; readonly message: string }
  | {
      readonly kind: "clone";
      readonly cwd: readonly string[];
      readonly url: string;
      readonly dir: string;
      readonly depth?: number;
      readonly ref?: string;
      readonly singleBranch?: boolean;
      readonly noCheckout: boolean;
      readonly noTags: boolean;
      readonly quiet: boolean;
    }
  | {
      readonly kind: "fetch";
      readonly cwd: readonly string[];
      readonly remote?: string;
      readonly url?: string;
      readonly depth?: number;
      readonly tags: boolean;
      readonly prune: boolean;
      readonly singleBranch: boolean;
      readonly quiet: boolean;
    };
