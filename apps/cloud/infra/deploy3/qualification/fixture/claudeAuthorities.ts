import type {
  HarnessCProductAccessService,
  HarnessCProductExecutorService,
} from "../../../../src/harness/HarnessCProductCapabilities.ts";
import type { ClaudeContinuationCapability } from "./claudeContinuations.ts";

export interface ClaudeAuthorityBindings {
  readonly CLAUDE_ACCESS?: Fetcher & HarnessCProductAccessService<unknown>;
  readonly CLAUDE_EXECUTOR?: Fetcher & HarnessCProductExecutorService<unknown>;
  readonly CLAUDE_CONTINUATION_PUBLISHER?: ClaudeContinuationCapability;
}

/** Every disposable binding still supplies the normal public product capability methods. */
export function requireClaudeAuthorities(env: {
  readonly CLAUDE_FIXTURES?: {
    getByName(
      name: string,
    ): HarnessCProductAccessService<unknown> &
      HarnessCProductExecutorService<unknown> &
      ClaudeContinuationCapability;
  };
  readonly RUN_ID: string;
}) {
  const services = env.CLAUDE_FIXTURES?.getByName(env.RUN_ID);
  if (
    !services ||
    typeof services.resolveFreshAccess !== "function" ||
    typeof services.resolveInitialAccess !== "function" ||
    typeof services.resolveTurnAccess !== "function" ||
    typeof services.forward !== "function" ||
    typeof services.publishContinuation !== "function"
  )
    throw new Error("CLAUDE_QUALIFICATION_DISPOSABLE_FIXTURE_BINDINGS_MISSING");
  return { access: services, executor: services, continuations: services };
}
