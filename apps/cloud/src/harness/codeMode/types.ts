export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CodeModeToolDefinition {
  readonly name: string;
  readonly tool_name: { readonly name: string; readonly namespace: string | null };
  readonly description: string;
  readonly kind: "function" | "freeform";
  readonly input_schema: Json | null;
  readonly output_schema: Json | null;
}

export interface CodeModeExecuteRequest {
  readonly tool_call_id: string;
  readonly source: string;
  readonly enabled_tools: readonly CodeModeToolDefinition[];
  readonly yield_time_ms: number | null;
  readonly max_output_tokens: number | null;
}

export type CodeModeContent =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string; readonly detail?: string }
  | { readonly type: "input_audio"; readonly audio_url: string };

export interface CodeModeCellCode {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
}

export interface CodeModeCellInvocation {
  readonly code: CodeModeCellCode;
  readonly request: CodeModeExecuteRequest;
  readonly storedValues: Readonly<Record<string, Json>>;
}

export interface CodeModeCellCompletion {
  readonly terminated: boolean;
  readonly error: string | null;
  readonly writes: Readonly<Record<string, Json>>;
}

export interface CodeModeCellEvents {
  readonly emit: (
    event: { type: "content"; item: CodeModeContent } | { type: "yield" },
  ) => Promise<void>;
  readonly invoke: (index: number, input: Json | undefined, id: string) => Promise<Json>;
  readonly notify: (text: string) => Promise<void>;
  readonly cancelled: () => Promise<void>;
  /** Revokes callback authority before the worker acknowledges completion. */
  readonly closeCallbacks: () => Promise<void>;
  /** Called by the trusted wrapper after its guest work and timers have stopped. */
  readonly stopped: () => Promise<void>;
}

/** Rejection without stopped() leaves the worker lifetime unconfirmed. */
export interface CodeModeCellLoaderPort {
  readonly run: (
    input: CodeModeCellInvocation,
    events: CodeModeCellEvents,
  ) => Promise<CodeModeCellCompletion>;
}

export type WireResult<T> = { status: "ok"; value: T } | { status: "error"; message: string };
export type RuntimeBody = {
  cell_id: string;
  content_items: CodeModeContent[];
  code_mode_host_duration_ns: number;
};
export type RuntimeResponse =
  | { Yielded: RuntimeBody }
  | { Terminated: RuntimeBody }
  | { Result: RuntimeBody & { error_text: string | null } };
export type WaitOutcome = { LiveCell: RuntimeResponse } | { MissingCell: RuntimeResponse };

export type HostRequest =
  | {
      method: "session/open";
      sessionId: string;
      cellExecutionLimits?: { maxYieldTimeMs?: number; maxHeapSizeBytes?: number };
    }
  | { method: "session/execute"; sessionId: string; request: CodeModeExecuteRequest }
  | {
      method: "session/wait";
      sessionId: string;
      request: { cell_id: string; yield_time_ms: number };
    }
  | { method: "session/terminate"; sessionId: string; cellId: string }
  | { method: "session/shutdown"; sessionId: string };

export type ClientMessage =
  | {
      type: "connection/hello";
      supportedVersions: number[];
      requiredCapabilities: string[];
      optionalCapabilities: string[];
    }
  | { type: "operation/request"; id: number; request: HostRequest }
  | { type: "operation/cancel" | "operation/yield"; id: number }
  | {
      type: "delegate/response";
      id: number;
      result: WireResult<
        { type: "tool/result"; result: Json } | { type: "notification/delivered" }
      >;
    };

export const messageError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const ok = <T>(value: T): WireResult<T> => ({ status: "ok", value });
export const fail = (message: string): WireResult<never> => ({ status: "error", message });
