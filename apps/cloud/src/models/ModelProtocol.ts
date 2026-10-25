import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { RunId } from "@t3tools/contracts";

/** A resolved pool and the person whose current access it checks. */
export interface ModelPoolRoute {
  readonly objectName: string;
  readonly userId: string;
}

/** The granted turn's existing correlation ids, independent of caller-supplied headers. */
export interface ModelCallTrace {
  readonly runId: RunId;
  readonly traceId: string;
}

export type ModelForwardReply =
  | {
      readonly _tag: "forwarded";
      readonly response: Response;
      /** Time until CLIProxyAPI response headers. */
      readonly upstreamMs: number;
      /** What the thread should say when its account changed. */
      readonly accountMoved?: string;
    }
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "failed"; readonly reason: string };

/** The thread remains authoritative for its live run and registered secrets. */
export type ModelAuthorization =
  | {
      readonly _tag: "granted";
      readonly runId: RunId;
      readonly traceId: string;
      readonly pool: ModelPoolRoute;
      /** Scrub these values before forwarding; never log them. */
      readonly secrets: ReadonlyArray<SecretValue>;
    }
  /** A live token awaiting secrets is refused without sending the harness back to sign in. */
  | {
      readonly _tag: "unregistered";
      readonly runId: RunId;
      readonly traceId: string;
      readonly reason: string;
    }
  | { readonly _tag: "denied"; readonly reason: string };

export type LocalModelAuthorization =
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "granted"; readonly keyId: string; readonly pool: ModelPoolRoute };

/** Auth timing and identity accompany the pool outcome for the gateway's record. */
export type ModelServeReply =
  | { readonly _tag: "denied"; readonly reason: string; readonly authMs: number }
  | {
      readonly _tag: "granted";
      readonly runId: RunId;
      readonly traceId: string;
      readonly authMs: number;
      readonly reply: ModelForwardReply;
    }
  | {
      readonly _tag: "granted-local";
      readonly userId: string;
      readonly keyId: string;
      readonly authMs: number;
      readonly reply: ModelForwardReply;
    };

export interface ModelRequest {
  readonly token: string;
  readonly provider: ModelGatewayProvider;
  /** Provider path, including its query. */
  readonly path: string;
  readonly request: Request;
}

/** Verifies the cloud signature before any owner is contacted. */
export type LocalKeyVerifier = (
  token: string,
) => Promise<{ readonly userId: string; readonly secret: string } | null>;
