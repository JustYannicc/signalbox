// Deterministic test peer. Production WebSocket handling belongs to #1067.
import * as NodeAssert from "node:assert/strict";

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);
function handshake() {
  const parts = [];
  const number = (n) => {
    const v = new Uint8Array(4);
    new DataView(v.buffer).setUint32(0, n, true);
    parts.push(v);
  };
  const blob = (v) => {
    number(v.length);
    parts.push(v);
  };
  number(101);
  number(2);
  blob(bytes("set-cookie"));
  blob(bytes("session=" + "a".repeat(5000)));
  blob(bytes("set-cookie"));
  blob(bytes("second=2"));
  blob(new Uint8Array());
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function createPeer(mode, descriptors, events) {
  let memory;
  let fd;
  let alias;
  let state = "connecting";
  let handshakePending = true;
  let blocked = false;
  let flushBlocked = false;
  let creditRace = ["credit", "cancel-next", "cancel-send"].includes(mode);
  let orphanPublished = false;
  let received = [];
  let closeCount = 0;
  let handshakeEnobufs = 0;
  let recvEnobufs = 0;
  let readyChecks = 0;
  const sent = [];
  const listeners = { read: new Set(), write: new Set() };
  const response = handshake();
  const view = () => new DataView(memory.buffer);
  const notify = () => {
    for (const direction of ["read", "write"])
      for (const fn of Array.from(listeners[direction])) fn();
  };
  const publish = () => {
    received.push(bytes("r".repeat(8192)));
    if (mode === "repeated") received.push(bytes("r".repeat(8192)));
    events.push("reply-published");
    notify();
  };
  const resource = {
    ready(direction) {
      NodeAssert.ok(++readyChecks < 10000, "level-triggered WASI readiness spin");
      if (state === "closed") return { bytes: 0n, hangup: true };
      if (state !== "open") return undefined;
      if (direction === "read")
        return handshakePending || received.length ? { bytes: 1n } : undefined;
      return blocked || flushBlocked ? undefined : { bytes: 1024n * 1024n };
    },
    subscribe(direction, fn) {
      listeners[direction].add(fn);
      return () => listeners[direction].delete(fn);
    },
    close() {
      closeCount++;
      state = "released";
      received = [];
      for (const direction of ["read", "write"]) listeners[direction].clear();
    },
  };
  const check = (candidate) => {
    NodeAssert.equal(candidate >>> 0, fd);
    NodeAssert.equal(descriptors.resource(candidate >>> 0), resource);
  };
  function copy(payload, pointer, capacity, required) {
    view().setUint32(required >>> 0, payload.length, true);
    if (capacity >>> 0 < payload.length) return 42;
    new Uint8Array(memory.buffer, pointer >>> 0, payload.length).set(payload);
    return 0;
  }
  const imports = {
    ws_open(pointer, length, output) {
      const request = new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0);
      NodeAssert.equal(new DataView(request.buffer, request.byteOffset).getUint32(0, true), 1);
      fd = descriptors.register(resource);
      if (mode === "alias" || mode === "cancel-alias") alias = descriptors.duplicate(fd);
      view().setUint32(output >>> 0, fd, true);
      events.push("fd-opened");
      return 0;
    },
    ws_handshake(candidate, pointer, capacity, required) {
      check(candidate);
      if (state === "connecting") return 6;
      if (!handshakePending) return 28;
      const result = copy(response, pointer, capacity, required);
      if (result === 42) {
        handshakeEnobufs++;
        NodeAssert.ok(resource.ready("read"));
      } else {
        handshakePending = false;
        NodeAssert.equal(resource.ready("read"), undefined);
      }
      return result;
    },
    ws_recv(candidate, opcode, pointer, capacity, required) {
      check(candidate);
      if (!received.length) return state === "closed" ? 0 : 6;
      const payload = received[0];
      view().setUint32(opcode >>> 0, 1, true);
      const result = copy(payload, pointer, capacity, required);
      if (result === 42) {
        recvEnobufs++;
        NodeAssert.equal(received[0], payload);
      } else received.shift();
      return result;
    },
    ws_ready(candidate) {
      check(candidate);
      return state === "open" && !blocked ? 0 : 6;
    },
    ws_send(candidate, opcode, pointer, length) {
      check(candidate);
      const payload = new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0).slice();
      NodeAssert.equal(opcode, 1);
      if (creditRace) {
        creditRace = false;
        blocked = true;
        events.push("send-eagain");
        NodeAssert.equal(sent.length, 0);
        return 6;
      }
      if (blocked) {
        NodeAssert.equal(sent.length, 0);
        return 6;
      }
      NodeAssert.equal(state, "open");
      sent.push(new TextDecoder().decode(payload));
      events.push("sent:" + sent.at(-1));
      if (mode === "flush" && sent.length === 1) flushBlocked = true;
      if (mode === "early" && sent.length === 2) publish();
      return 0;
    },
    ws_flush(candidate) {
      check(candidate);
      return blocked || flushBlocked ? 6 : 0;
    },
    ws_close(candidate) {
      check(candidate);
      if (["close", "repeated"].includes(mode) && state === "open") {
        state = "closing";
        return 6;
      }
      if (state === "closing") return 6;
      state = "closed";
      notify();
      return 0;
    },
    ws_drop(candidate) {
      check(candidate);
      descriptors.close(candidate >>> 0);
      events.push("fd-dropped");
      return 0;
    },
  };
  return {
    imports,
    attach(value) {
      memory = value;
    },
    poll([pointer, _output, count]) {
      const directions = [];
      let clock = false;
      for (let index = 0; index < count >>> 0; index++) {
        const offset = (pointer >>> 0) + index * 48;
        const tag = view().getUint8(offset + 8);
        if (tag === 0) clock = true;
        else {
          NodeAssert.equal(view().getUint32(offset + 16, true), fd);
          directions.push(tag === 1 ? "read" : "write");
        }
      }
      // A registry wait can be canceled by another ready subscription. Advance
      // the peer only when the actual poll has no immediately ready direction.
      if (clock || !directions.length || directions.some((direction) => resource.ready(direction)))
        return;
      events.push("park:" + state);
      queueMicrotask(() => {
        if (state === "connecting") {
          state = "open";
          events.push("handshake-ready");
          notify();
        } else if (mode === "cancel-next" && blocked && !orphanPublished) {
          orphanPublished = true;
          publish();
        } else if (flushBlocked) {
          flushBlocked = false;
          events.push("flush-ready");
          notify();
        } else if (blocked) {
          blocked = false;
          events.push("credit-ready");
          notify();
        } else if (state === "closing") {
          state = "closed";
          events.push("close-ready");
          notify();
        } else if (sent.length === 2 || mode === "cancel-send") publish();
      });
    },
    assertComplete() {
      const canceled = mode === "cancel" || mode === "cancel-alias";
      if (!canceled) {
        NodeAssert.deepEqual(sent, ["initialize", "second"]);
        NodeAssert.equal(handshakeEnobufs, 1);
        NodeAssert.equal(recvEnobufs, mode === "repeated" ? 2 : 1);
        if (mode !== "cancel-send")
          NodeAssert.ok(events.indexOf("sent:initialize") < events.indexOf("guest:reply"));
        if (mode === "early") NodeAssert.ok(!events.includes("park:open"));
        if (mode === "repeated")
          NodeAssert.ok(events.indexOf("guest:closed") < events.indexOf("guest:repeated-reply"));
        if (mode === "flush") NodeAssert.ok(events.includes("flush-ready"));
        if (mode === "credit") NodeAssert.ok(events.includes("credit-ready"));
        if (mode === "close") NodeAssert.ok(events.includes("close-ready"));
      }
      NodeAssert.ok(!descriptors.table.has(fd), "guest descriptor leaked");
      if (alias !== undefined) {
        NodeAssert.equal(closeCount, 0, "nonfinal descriptor release closed the resource");
        NodeAssert.equal(descriptors.resource(alias), resource);
        descriptors.close(alias);
      }
      NodeAssert.equal(closeCount, 1);
      NodeAssert.equal(listeners.read.size + listeners.write.size, 0);
      return { handshakeEnobufs, recvEnobufs, closeCount };
    },
  };
}
