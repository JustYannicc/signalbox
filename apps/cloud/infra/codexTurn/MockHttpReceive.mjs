export function createMockHttpReceiver({
  currentMemory,
  memoryView,
  writeU32,
  socketFor,
  descriptorErrno,
  errno,
}) {
  const receiveSync = (fd, bufferPointer, bufferLength, flags, retReceivedPointer) => {
    try {
      const wasmMemory = currentMemory();
      memoryView(wasmMemory, retReceivedPointer, 4);
      const { offset, size } = memoryView(wasmMemory, bufferPointer, bufferLength);
      if (flags !== 0) return errno.NOTSUP;
      writeU32(wasmMemory, retReceivedPointer, 0);
      const count = socketFor(fd).read(new Uint8Array(wasmMemory.buffer, offset, size));
      writeU32(wasmMemory, retReceivedPointer, count);
      return errno.SUCCESS;
    } catch (error) {
      return descriptorErrno(error);
    }
  };

  const receiveAsync = async (fd, bufferPointer, bufferLength, flags, retReceivedPointer) => {
    try {
      const wasmMemory = currentMemory();
      memoryView(wasmMemory, retReceivedPointer, 4);
      memoryView(wasmMemory, bufferPointer, bufferLength);
      if (flags !== 0) return errno.NOTSUP;
      writeU32(wasmMemory, retReceivedPointer, 0);

      const socket = socketFor(fd);
      if (socket.ready("read") === undefined) {
        const ready = await waitForMockHttpReadiness(socket);
        if (!ready) return errno.AGAIN;
      }

      const current = currentMemory();
      const { offset, size } = memoryView(current, bufferPointer, bufferLength);
      memoryView(current, retReceivedPointer, 4);
      const count = socket.read(new Uint8Array(current.buffer, offset, size));
      writeU32(current, retReceivedPointer, count);
      return errno.SUCCESS;
    } catch (error) {
      return descriptorErrno(error);
    }
  };

  return Object.freeze({ receiveSync, receiveAsync });
}

export function waitForMockHttpReadiness(socket) {
  if (socket.ready("read") !== undefined) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => undefined;
    let timeout;

    const finish = (ready) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(ready);
    };
    const check = () => {
      if (socket.ready("read") !== undefined) finish(true);
    };

    unsubscribe = socket.subscribe("read", check);
    if (socket.recvTimeoutMs !== null) {
      timeout = setTimeout(() => finish(false), socket.recvTimeoutMs);
    }
    check();
  });
}
