// @effect-diagnostics cryptoRandomUUID:off - the Durable Object's socket boundary: plain promises, outside any Effect.
import {
  type DataFrame,
  DATA_KIND,
  RUNNER_STREAM_BASE,
  type TunnelThreadMessage,
} from "@signalbox/runner-protocol/PreviewTunnel";
import type { AgentBrowserInput, AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";

import { concatBytes } from "../../drive/git/gitObjects.ts";
import { browserBehindLine, type BrowserReply, browserUpdateLine } from "../threadWire.ts";
import { MAX_STEP_BYTES } from "./BrowserTrail.ts";

/**
 * The thread object's half of the agent's browser (#587), on the
 * PreviewGateway's tunnel. Each watcher is one `mirror.open` stream on the
 * welcomed tunnel, numbered like the gateway's own; the Runner answers with
 * newline-delimited `AgentBrowserUpdate` JSON in body data frames, relayed to
 * the watcher line by line. Only `state` lines are read, to name the viewer
 * (`state.viewerId`); the rest pass through as bytes. The thread says
 * `offline` and `step` itself: a viewer outlives the machines it watches, and
 * a step is news only once the trail holds it.
 *
 * A watcher that falls `MAX_QUEUED_BYTES` behind ends with `browserBehindLine`
 * rather than an error, so nothing reopens it while its person is away.
 *
 * Watching never holds the machine's lease: a mirror left open with nobody
 * looking costs nothing. Without a mirroring machine a watcher sees `offline`
 * and waits; the next one that says hello picks it up.
 *
 * Every finished step arrives as a `trail.step` stream the Runner numbers from
 * `RUNNER_STREAM_BASE`, its recording as body data, then `end`; it is kept by
 * `host.storeStep`, one at a time, in the order the steps ended.
 */

/** All recordings arriving at once, so a burst can't exhaust the object's memory. */
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
/** Largest line a watcher takes; past it the Runner is misbehaving. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** What may queue for a slow watcher before it is cut off rather than buffered without end. */
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE_BYTES = encoder.encode("\n");
/** How the Runner's `state` lines start (`RunnerBrowserMirror.ts` writes `_tag` first). */
const STATE_PREFIX = encoder.encode('{"_tag":"state"');

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.byteLength >= prefix.byteLength && prefix.every((byte, index) => bytes[index] === byte);

export interface BrowserMirrorHost {
  /** The welcomed tunnel, and whether its Runner mirrors (`hello.mirror`). */
  readonly tunnel: () => { readonly socket: WebSocket; readonly mirror: boolean } | null;
  readonly send: (socket: WebSocket, message: TunnelThreadMessage) => boolean;
  /** A stream number for the thread's side, not in use by anything else. */
  readonly newStream: () => number;
  readonly canSee: (userId: string) => Promise<boolean>;
  /** Keeps a finished step and its recording; rejects when it couldn't. */
  readonly storeStep: (
    step: AgentBrowserStep,
    recording: ReadonlyArray<Uint8Array>,
  ) => Promise<void>;
  readonly logError: (message: string, cause: unknown) => void;
  /** For tests; random otherwise. */
  readonly viewerId?: () => string;
}

interface Viewer {
  readonly id: string;
  readonly userId: string;
  readonly tabId: string | null;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  /** Its stream on the tunnel; null while no mirroring machine runs. */
  stream: number | null;
  /** Whether it was told `offline` since it last had a stream. */
  offline: boolean;
  /** The line arriving, in pieces. */
  line: Array<Uint8Array>;
  lineBytes: number;
}

interface Upload {
  readonly step: AgentBrowserStep;
  readonly chunks: Array<Uint8Array>;
  bytes: number;
}

const OFFLINE_LINE = encoder.encode(`${browserUpdateLine({ _tag: "offline" })}\n`);
const BEHIND_LINE = encoder.encode(`${browserBehindLine}\n`);

export class BrowserMirror {
  private readonly byId = new Map<string, Viewer>();
  private readonly byStream = new Map<number, Viewer>();
  private readonly uploads = new Map<number, Upload>();
  private uploadBytes = 0;
  /** Steps are kept one after another, so the trail lists them in the order they ended. */
  private storing: Promise<void> = Promise.resolve();
  private readonly host: BrowserMirrorHost;
  private readonly viewerId: () => string;

  constructor(host: BrowserMirrorHost) {
    this.host = host;
    this.viewerId = host.viewerId ?? (() => crypto.randomUUID());
  }

  /** Whether `stream` is a mirror's or a recording's, so the gateway numbers around it. */
  owns(stream: number) {
    return this.byStream.has(stream) || this.uploads.has(stream);
  }

  /** Newline-delimited `AgentBrowserUpdate` JSON while the stream is read; null when `userId` can't see the thread. */
  async watch(userId: string, tabId: string | null): Promise<ReadableStream<Uint8Array> | null> {
    if (!(await this.host.canSee(userId))) return null;
    let viewer: Viewer | null = null;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          viewer = {
            id: this.viewerId(),
            userId,
            tabId,
            controller,
            stream: null,
            offline: false,
            line: [],
            lineBytes: 0,
          };
          this.byId.set(viewer.id, viewer);
          this.attach(viewer);
        },
        cancel: () => {
          if (viewer !== null) this.drop(viewer, { cancel: true });
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
    );
  }

  /** Forwards a viewer's input to the machine; only the user watching through it may send it. */
  input(userId: string, viewerId: string, input: AgentBrowserInput): BrowserReply<null> {
    const viewer = this.byId.get(viewerId);
    if (viewer === undefined || viewer.userId !== userId) {
      return { _tag: "unavailable", message: "This view of the browser closed. Open it again." };
    }
    const tunnel = this.host.tunnel();
    if (viewer.stream === null || tunnel === null || !tunnel.mirror) {
      return { _tag: "unavailable", message: "This thread's machine isn't running." };
    }
    this.host.send(tunnel.socket, { type: "mirror.input", stream: viewer.stream, input });
    return { _tag: "ok", value: null };
  }

  /** A tunnel was welcomed, new or replacing one: every watcher moves to it. */
  connected() {
    this.dropUploads();
    for (const viewer of this.byId.values()) this.attach(viewer);
  }

  /** The tunnel went away: watchers see `offline` and wait for the next machine. */
  disconnected() {
    this.dropUploads();
    for (const viewer of this.byId.values()) {
      this.detach(viewer);
      this.sayOffline(viewer);
    }
  }

  onTrailStep(stream: number, step: AgentBrowserStep) {
    // Only the Runner's own numbers, so a recording never lands on a mirror.
    if (stream < RUNNER_STREAM_BASE || this.uploads.has(stream)) return;
    this.uploads.set(stream, { step, chunks: [], bytes: 0 });
  }

  /** Whether the frame was a mirror's or a recording's. */
  onData(frame: DataFrame): boolean {
    if (frame.kind !== DATA_KIND.body) return false;
    const viewer = this.byStream.get(frame.stream);
    if (viewer !== undefined) {
      this.feed(viewer, frame.payload);
      return true;
    }
    const upload = this.uploads.get(frame.stream);
    if (upload === undefined) return false;
    upload.chunks.push(frame.payload);
    upload.bytes += frame.payload.byteLength;
    this.uploadBytes += frame.payload.byteLength;
    if (upload.bytes > MAX_STEP_BYTES || this.uploadBytes > MAX_UPLOAD_BYTES) {
      this.dropUpload(frame.stream);
      const tunnel = this.host.tunnel();
      if (tunnel !== null) this.host.send(tunnel.socket, { type: "cancel", stream: frame.stream });
      this.host.logError("browser step recording dropped", {
        stepId: upload.step.stepId,
        bytes: upload.bytes,
      });
    }
    return true;
  }

  /** The Runner ended `stream`: a recording is complete, or a mirror is over. */
  async onEnd(stream: number): Promise<boolean> {
    const viewer = this.byStream.get(stream);
    if (viewer !== undefined) {
      this.drop(viewer, { cancel: false });
      return true;
    }
    const upload = this.uploads.get(stream);
    if (upload === undefined) return false;
    this.dropUpload(stream);
    await this.keep(upload);
    return true;
  }

  /** The Runner failed `stream`; a mirror's watcher sees it fail. */
  onFail(stream: number, message: string): boolean {
    const viewer = this.byStream.get(stream);
    if (viewer !== undefined) {
      this.drop(viewer, { cancel: false, error: new Error(message) });
      return true;
    }
    if (!this.uploads.has(stream)) return false;
    this.dropUpload(stream);
    return true;
  }

  private keep(upload: Upload) {
    const kept = this.storing.then(async () => {
      try {
        await this.host.storeStep(upload.step, upload.chunks);
      } catch (cause) {
        this.host.logError("browser step not stored", cause);
        return;
      }
      const line = encoder.encode(`${browserUpdateLine({ _tag: "step", step: upload.step })}\n`);
      for (const viewer of this.byId.values()) this.emit(viewer, line);
    });
    this.storing = kept;
    return kept;
  }

  private attach(viewer: Viewer) {
    this.detach(viewer);
    const tunnel = this.host.tunnel();
    if (tunnel === null || !tunnel.mirror) {
      this.sayOffline(viewer);
      return;
    }
    const stream = this.host.newStream();
    viewer.stream = stream;
    viewer.offline = false;
    this.byStream.set(stream, viewer);
    this.host.send(tunnel.socket, { type: "mirror.open", stream, tabId: viewer.tabId });
  }

  private detach(viewer: Viewer) {
    if (viewer.stream !== null) this.byStream.delete(viewer.stream);
    viewer.stream = null;
    viewer.line = [];
    viewer.lineBytes = 0;
  }

  private sayOffline(viewer: Viewer) {
    if (viewer.offline) return;
    viewer.offline = true;
    this.emit(viewer, OFFLINE_LINE);
  }

  /**
   * Ends a watcher; `cancel` tells the machine, unless it ended the mirror
   * itself. `last` is the watcher's last line, read before the stream closes.
   */
  private drop(
    viewer: Viewer,
    how: { readonly cancel: boolean; readonly error?: Error; readonly last?: Uint8Array },
  ) {
    if (this.byId.get(viewer.id) !== viewer) return;
    this.byId.delete(viewer.id);
    const stream = viewer.stream;
    this.detach(viewer);
    const tunnel = this.host.tunnel();
    if (how.cancel && stream !== null && tunnel !== null) {
      this.host.send(tunnel.socket, { type: "cancel", stream });
    }
    try {
      if (how.last !== undefined) viewer.controller.enqueue(how.last);
      if (how.error === undefined) viewer.controller.close();
      else viewer.controller.error(how.error);
    } catch {
      // Already cancelled.
    }
  }

  /** Splits the mirror's bytes into lines; a line may span frames. */
  private feed(viewer: Viewer, payload: Uint8Array) {
    let start = 0;
    while (start < payload.byteLength) {
      const end = payload.indexOf(NEWLINE, start);
      if (end === -1) {
        viewer.line.push(payload.subarray(start));
        viewer.lineBytes += payload.byteLength - start;
        if (viewer.lineBytes > MAX_LINE_BYTES) {
          this.drop(viewer, {
            cancel: true,
            error: new Error("The browser sent too much at once."),
          });
        }
        return;
      }
      const line = concatBytes([...viewer.line, payload.subarray(start, end)]);
      viewer.line = [];
      viewer.lineBytes = 0;
      this.relay(viewer, line);
      start = end + 1;
    }
  }

  private relay(viewer: Viewer, line: Uint8Array) {
    if (line.byteLength === 0) return;
    if (!startsWith(line, STATE_PREFIX)) {
      this.emit(viewer, line, true);
      return;
    }
    let state: object;
    try {
      state = JSON.parse(decoder.decode(line));
    } catch {
      return;
    }
    this.emit(viewer, encoder.encode(`${JSON.stringify({ ...state, viewerId: viewer.id })}\n`));
  }

  private emit(viewer: Viewer, bytes: Uint8Array, newline = false) {
    try {
      viewer.controller.enqueue(bytes);
      if (newline) viewer.controller.enqueue(NEWLINE_BYTES);
    } catch {
      this.drop(viewer, { cancel: true });
      return;
    }
    if ((viewer.controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
      this.drop(viewer, { cancel: true, last: BEHIND_LINE });
    }
  }

  private dropUpload(stream: number) {
    const upload = this.uploads.get(stream);
    if (upload === undefined) return;
    this.uploads.delete(stream);
    this.uploadBytes -= upload.bytes;
  }

  private dropUploads() {
    this.uploads.clear();
    this.uploadBytes = 0;
  }
}
