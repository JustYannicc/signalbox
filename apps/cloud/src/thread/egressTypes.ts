/** The thread object's answers and inputs at the external request boundary. */
export type SendAnswer =
  | { readonly _tag: "allowed" }
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "waiting"; readonly message: string };

/** One request's question to the gate: its host, the secrets it carries, how long it may wait. */
export interface SendRequest {
  readonly host: string;
  readonly names: ReadonlyArray<string>;
  readonly waitMs: number;
}

export type EgressDispatchAnswer =
  | { readonly _tag: "stale" }
  | { readonly _tag: "sent"; readonly response: Response };
