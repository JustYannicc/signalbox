interface CodeModeCellIdentity {
  readonly sessionId: string;
  readonly cellId: string;
  readonly tool_call_id: string;
}

export type CodeModeLifecycleEvent = CodeModeCellIdentity &
  (
    | { readonly type: "started" }
    | { readonly type: "queued-cancel" }
    | {
        readonly type: "closed";
        readonly started: boolean;
        readonly outcome: "completed" | "aborted" | "error";
        readonly error: string | null;
      }
  );

/** Synchronous observation. Exceptions become cell errors after physical cleanup completes. */
export type CodeModeLifecycleObserver = (event: CodeModeLifecycleEvent) => void;
