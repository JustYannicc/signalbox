import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import type { PreparedVoiceTranscription, VoiceTranscriber } from "./transcription.ts";

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export type VoiceInputPhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing"
  );
}

export function voiceInputFreezesEditor(state: VoiceInputState): boolean {
  return voiceInputBlocksSubmission(state);
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
}

export type VoiceRecordingDraftChange = {
  readonly before: VoiceDraftSnapshot;
  readonly after: VoiceDraftSnapshot;
};

export type VoiceRecordingSinkContext = {
  readonly expectedDraft: VoiceDraftSnapshot;
  /** Reads the target text and revision; use the live composer caret for `after.selection`. */
  readonly readDraft: () => VoiceDraftSnapshot | null;
};

/**
 * Resolve after the source is attached durably. Return snapshots read around the attachment's own
 * draft change; `after.selection` may be the composer caret after the inserted audio marker.
 */
export type VoiceRecordingSink = (
  uri: string,
  context: VoiceRecordingSinkContext,
) => Promise<void | VoiceRecordingDraftChange>;

export type VoiceInputControllerDependencies = {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly getRecordingSink?: () => VoiceRecordingSink | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
};

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

type PendingVoiceRecording = {
  readonly ownerKey: string;
  readonly uri: string;
  readonly uris: readonly string[];
  readonly sink: VoiceRecordingSink;
  readonly capturedDraft: VoiceDraftSnapshot;
  readonly transcription: PreparedVoiceTranscription | null;
};

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  const isEmptySelection = captured.selection.start === captured.selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;
  if (isEmptySelection && usesEnglishSpacing) {
    const left = captured.text[captured.selection.start - 1];
    const right = captured.text[captured.selection.start];
    const leftNeedsBoundary =
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));
    const rightNeedsBoundary =
      right !== undefined &&
      /[A-Za-z0-9([{'"]/.test(right) &&
      (left === undefined || /\s/.test(left));
    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const result = replaceTextRange(
    captured.text,
    captured.selection.start,
    captured.selection.end,
    insertion,
  );
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
  };
}

type VoiceInputSession = {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
};

let activeSession: VoiceInputSession | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;
  const { promise, resolve } = Promise.withResolvers<void>();
  const token = { abandoned: false, released: promise, release: resolve };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceInputSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
}

async function runTranscriptionOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTranscriptionOperation) {
    throw new Error("voice-operation-busy");
  }

  const promise = operation();
  activeTranscriptionOperation = promise;
  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  if (errorCode(error) === "unsupported-locale") {
    return "Voice transcription is not available for this language.";
  }
  return "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown, audioSaved: boolean): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return audioSaved
      ? "Audio note saved, but voice transcription is still finishing."
      : "Voice transcription is still finishing. Try again shortly.";
  }
  return audioSaved
    ? "Audio note saved, but could not transcribe this recording."
    : "Could not transcribe this recording.";
}

function transcriptResultMessage(result: "stale" | "empty", audioSaved: boolean): string {
  const savedPrefix = audioSaved ? "Audio note saved. " : "";
  return result === "stale"
    ? `${savedPrefix}The draft changed while voice input was running. The transcript was not added.`
    : `${savedPrefix}No speech was detected.`;
}

function sameDraftSnapshot(
  left: VoiceDraftSnapshot | null,
  right: VoiceDraftSnapshot,
): boolean {
  return (
    left !== null &&
    sameDraftContent(left, right) &&
    left.selection.start === right.selection.start &&
    left.selection.end === right.selection.end
  );
}

function sameDraftContent(
  left: VoiceDraftSnapshot | null,
  right: VoiceDraftSnapshot,
): boolean {
  return (
    left !== null &&
    left.ownerKey === right.ownerKey &&
    left.text === right.text &&
    left.revision === right.revision
  );
}

function hasValidSelection(snapshot: VoiceDraftSnapshot): boolean {
  const { start, end } = snapshot.selection;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    end <= snapshot.text.length
  );
}

function transcriptDraftAfterAttachment(
  expectedDraft: VoiceDraftSnapshot,
  liveBefore: VoiceDraftSnapshot | null,
  change: void | VoiceRecordingDraftChange,
  liveAfter: VoiceDraftSnapshot | null,
): VoiceDraftSnapshot {
  if (
    !change ||
    !sameDraftSnapshot(liveBefore, expectedDraft) ||
    !sameDraftSnapshot(change.before, expectedDraft) ||
    change.after.ownerKey !== expectedDraft.ownerKey ||
    !hasValidSelection(change.after) ||
    !sameDraftContent(liveAfter, change.after)
  ) {
    return expectedDraft;
  }
  return change.after;
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  // A later cancellation or start request supersedes queued restarts behind native cleanup.
  private startRequestGeneration = 0;
  private startPromise: Promise<void> | null = null;
  private finishPromise: Promise<void> | null = null;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private recordingSink: VoiceRecordingSink | null = null;
  private pendingRecording: PendingVoiceRecording | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private recordingStarted = false;
  // Capture recordings belong to the sink until it confirms a durable copy.
  private deleteRecordingOnRelease = true;

  constructor(dependencies: VoiceInputControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  get pendingRecordingOwnerKey(): string | null {
    return this.pendingRecording?.ownerKey ?? null;
  }

  start(): Promise<void> {
    const pending = this.pendingRecording;
    if (this.finishPromise) {
      if (pending && this.state.phase === "error") {
        return this.startAfterOperation(this.finishPromise, true);
      }
      if (this.state.phase === "idle") return this.startAfterOperation(this.finishPromise);
      return Promise.resolve();
    }
    if (this.startPromise && !(this.pendingRecording && this.state.phase === "error")) {
      if (this.state.phase === "idle") return this.startAfterOperation(this.startPromise);
      return this.startPromise;
    }
    if (this.state.phase !== "idle" && this.state.phase !== "error") {
      return Promise.resolve();
    }

    if (pending) {
      const currentDraft = this.dependencies.readDraft();
      if (!currentDraft || currentDraft.ownerKey !== pending.ownerKey) {
        this.setError("A voice note from another draft still needs saving.", "retry");
        return Promise.resolve();
      }
      return this.runStartOperation(() => this.retryPendingRecording(pending));
    }
    return this.runStartOperation(() => this.startRecording());
  }

  // Canceled native work still owns cleanup; do not open another microphone session before it settles.
  private startAfterOperation(
    operation: Promise<void>,
    allowPendingRetry = false,
  ): Promise<void> {
    const requestGeneration = ++this.startRequestGeneration;
    return operation.catch(() => undefined).then(() => {
      if (requestGeneration !== this.startRequestGeneration) return;
      const retryingPending =
        allowPendingRetry && this.pendingRecording !== null && this.state.phase === "error";
      if (this.state.phase !== "idle" && !retryingPending) return;
      return this.start();
    });
  }

  private runStartOperation(operation: () => Promise<void>): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.startPromise = promise;
    void operation().then(
      () => {
        if (this.startPromise === promise) this.startPromise = null;
        resolve();
      },
      (error: unknown) => {
        if (this.startPromise === promise) this.startPromise = null;
        reject(error);
      },
    );
    return promise;
  }

  private async startRecording(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiatingDraft = this.dependencies.readDraft();
    if (!initiatingDraft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    const recordingSink = this.dependencies.getRecordingSink?.() ?? null;
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "retry");
        return;
      }
      this.sessionToken = sessionToken;
      this.recordingSink = recordingSink;
      this.deleteRecordingOnRelease = recordingSink === null;
      this.recordingStarted = false;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;

      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber && !recordingSink) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.dependencies.requestPermission();
      if (!this.isCurrent(operationToken)) return;
      if (!permission.granted) {
        this.setError(
          "Microphone access is required for voice input.",
          permission.canAskAgain ? "retry" : "settings",
        );
        return;
      }

      if (transcriber) {
        try {
          this.transcription = await runTranscriptionOperation(() =>
            transcriber.prepare({ signal: abortController.signal }),
          );
        } catch (error) {
          if (!recordingSink) {
            if (this.isCurrent(operationToken))
              this.setError(preparationErrorMessage(error), "retry");
            return;
          }
          this.transcription = null;
        }
      }
      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.dependencies.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.deleteRecordingOnRelease = true;
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.setState({ phase: "recording", error: null, errorAction: null });
      this.recordingStarted = true;
      this.dependencies.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
    } catch {
      if (
        this.isCurrent(operationToken) &&
        this.currentState.phase !== "transcribing" &&
        this.currentState.phase !== "idle"
      )
        this.setError("Could not start voice recording.", "retry");
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishPromise) {
          await this.releaseResources();
        }
      }
    }
  }

  stop(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.startPromise) return this.startPromise.then(() => this.stop());
    if (this.state.phase === "recording") return this.finishRecording(false, null);
    return Promise.resolve();
  }

  cancel(): void {
    this.startRequestGeneration += 1;
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        if (this.pendingRecording) this.discardPendingRecording();
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        if (this.pendingRecording) this.discardPendingRecording();
        this.deleteRecordingOnRelease = true;
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        this.discardRecording(null);
        return;
      case "transcribing":
        this.deleteRecordingOnRelease = true;
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    if (this.recordingSink) {
      return this.finishRecording(false, completedUri, message);
    }
    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | void {
    this.startRequestGeneration += 1;
    if (this.state.phase === "preparing") {
      this.deleteRecordingOnRelease = true;
      this.invalidateOperation();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
      return;
    }
    return this.interruptRecording();
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Voice recording was interrupted.",
        status.url,
      );
    }
    if (status.isFinished) {
      if (!status.url) {
        return this.interruptRecording();
      }
      return this.finishRecording(true, status.url);
    }
  }

  ownerChanged(): void {
    if (this.pendingRecording) return;
    if (this.state.phase === "idle") {
      this.startRequestGeneration += 1;
      return;
    }
    if (this.state.phase === "recording" && this.recordingSink) {
      this.interruptRecording();
      return;
    }
    this.cancel();
  }

  dispose(): void {
    this.startRequestGeneration += 1;
    if (this.state.phase === "recording") {
      if (this.recordingSink) this.interruptRecording();
      else this.discardRecording(null);
      return;
    }
    if (this.state.phase === "preparing") {
      this.deleteRecordingOnRelease = true;
      this.invalidateOperation();
      this.setState(IDLE_STATE);
      return;
    }
    if (this.state.phase === "transcribing") {
      this.deleteRecordingOnRelease = true;
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
    interruptionMessage: string | null = null,
  ): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.state.phase !== "recording") return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    const promise = completion.promise;
    this.finishPromise = promise;
    void this.finishRecordingOperation(alreadyStopped, completedUri, interruptionMessage).then(
      () => {
        if (this.finishPromise === promise) this.finishPromise = null;
        completion.resolve();
      },
      (error: unknown) => {
        if (this.finishPromise === promise) this.finishPromise = null;
        completion.reject(error);
      },
    );
    return promise;
  }

  private async finishRecordingOperation(
    alreadyStopped: boolean,
    completedUri: string | null,
    interruptionMessage: string | null,
  ): Promise<void> {
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      const recordingSink = this.recordingSink;
      if (!alreadyStopped) {
        try {
          await this.dependencies.recorder.stop();
        } catch (error) {
          if (!recordingSink || !completedUri) throw error;
        }
      }
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.recordingUri || !this.capturedDraft) {
        if (this.isCurrent(operationToken)) {
          this.setError("Could not finish voice recording.", "retry");
        }
        return;
      }

      const capturedDraft = this.capturedDraft;
      const recordingUri = this.recordingUri;
      let transcriptDraft = capturedDraft;
      if (recordingSink) {
        try {
          const liveBefore = this.dependencies.readDraft();
          const change = await recordingSink(recordingUri, {
            expectedDraft: capturedDraft,
            readDraft: this.dependencies.readDraft,
          });
          transcriptDraft = transcriptDraftAfterAttachment(
            capturedDraft,
            liveBefore,
            change,
            this.dependencies.readDraft(),
          );
          this.deleteRecordingOnRelease = true;
        } catch {
          if (!this.isCurrent(operationToken)) {
            this.deleteRecordingOnRelease = true;
            return;
          }
          this.deleteRecordingOnRelease = false;
          this.retainPendingRecording();
          this.setError("Could not save this voice note.", "retry");
          return;
        }
      }
      if (!this.isCurrent(operationToken)) return;

      if (!this.transcription || !this.transcriptionAbortController) {
        if (recordingSink) {
          if (interruptionMessage) {
            this.setError(`Voice note saved. ${interruptionMessage}`, "retry");
          } else {
            this.setState(IDLE_STATE);
          }
          return;
        }
        this.setError("Could not finish voice recording.", "retry");
        return;
      }
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      let transcript: string;
      try {
        transcript = await runTranscriptionOperation(() =>
          transcription.transcribe(recordingUri, { signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error, recordingSink !== null), "retry");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      const result = resolveTranscriptCommit(
        transcriptDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
      );
      if (result.kind === "stale") {
        this.setError(transcriptResultMessage("stale", recordingSink !== null), "retry");
        return;
      }
      if (result.kind === "empty") {
        this.setError(transcriptResultMessage("empty", recordingSink !== null), "retry");
        return;
      }

      this.dependencies.commitDraft(result.text, result.selection);
      if (interruptionMessage) {
        this.setError(`Voice note saved. ${interruptionMessage}`, "retry");
      } else {
        this.setState(IDLE_STATE);
      }
    } catch {
      if (this.isCurrent(operationToken)) {
        this.retainPendingRecording();
        this.setError("Could not finish voice recording.", "retry");
      }
    } finally {
      await this.releaseResources();
    }
  }

  private async retryPendingRecording(pending: PendingVoiceRecording): Promise<void> {
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    let transcriptDraft = pending.capturedDraft;
    try {
      const liveBefore = this.dependencies.readDraft();
      const change = await pending.sink(pending.uri, {
        expectedDraft: pending.capturedDraft,
        readDraft: this.dependencies.readDraft,
      });
      transcriptDraft = transcriptDraftAfterAttachment(
        pending.capturedDraft,
        liveBefore,
        change,
        this.dependencies.readDraft(),
      );
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Could not save this voice note.", "retry");
      }
      return;
    }

    if (this.pendingRecording === pending) {
      this.pendingRecording = null;
    }
    try {
      if (!this.isCurrent(operationToken)) return;
      const transcription = pending.transcription;
      if (!transcription) {
        this.setState(IDLE_STATE);
        return;
      }

      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;
      this.setState({ phase: "transcribing", error: null, errorAction: null });
      const transcript = await runTranscriptionOperation(() =>
        transcription.transcribe(pending.uri, { signal: abortController.signal }),
      );
      if (!this.isCurrent(operationToken)) return;

      const result = resolveTranscriptCommit(
        transcriptDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
      );
      if (result.kind === "stale") {
        this.setError(transcriptResultMessage("stale", true), "retry");
      } else if (result.kind === "empty") {
        this.setError(transcriptResultMessage("empty", true), "retry");
      } else {
        this.dependencies.commitDraft(result.text, result.selection);
        this.setState(IDLE_STATE);
      }
    } catch (error) {
      if (this.isCurrent(operationToken)) {
        this.setError(transcriptionErrorMessage(error, true), "retry");
      }
    } finally {
      this.deleteRecordingUris(pending.uris);
      this.transcriptionAbortController = null;
    }
  }

  private async discardRecording(error: string | null): Promise<void> {
    this.invalidateOperation();
    this.deleteRecordingOnRelease = true;
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry" }
        : { phase: "idle", error: null, errorAction: null },
    );
    try {
      await this.dependencies.recorder.stop();
    } catch {
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    this.rememberRecordingUri(this.recordingUri);
    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {}
    this.recordingUri = null;
    if (this.deleteRecordingOnRelease || !this.pendingRecording) {
      this.deleteRecordingUris([...this.ownedRecordingUris]);
    }
    this.ownedRecordingUris.clear();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
    this.recordingSink = null;
    this.recordingStarted = false;
    this.deleteRecordingOnRelease = true;
  }

  private retainPendingRecording(): void {
    if (
      this.pendingRecording ||
      this.deleteRecordingOnRelease ||
      !this.recordingSink ||
      !this.recordingStarted ||
      !this.recordingUri ||
      !this.capturedDraft
    ) {
      return;
    }
    this.pendingRecording = {
      ownerKey: this.capturedDraft.ownerKey,
      uri: this.recordingUri,
      uris: [...this.ownedRecordingUris],
      sink: this.recordingSink,
      capturedDraft: this.capturedDraft,
      transcription: this.transcription,
    };
  }

  private discardPendingRecording(): void {
    const pending = this.pendingRecording;
    if (!pending) return;
    this.pendingRecording = null;
    this.deleteRecordingOnRelease = true;
    this.deleteRecordingUris(pending.uris);
  }

  private deleteRecordingUris(uris: readonly string[]): void {
    for (const uri of uris) {
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
    }
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {}
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    if (this.sessionToken) this.sessionToken.abandoned = true;
    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function resetVoiceInputGlobalsForTests(): void {
  activeSession = null;
  activeTranscriptionOperation = null;
}
