type ByteQueue = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly push: (chunk: Uint8Array) => boolean;
  readonly close: () => void;
  readonly error: (error: Error) => void;
};

export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + 16_384)),
    );
  }
  return btoa(binary);
};

export const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const byteQueue = (): ByteQueue => {
  const maximumBufferedBytes = 1_048_576;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  let failure: Error | null = null;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        if (failure !== null) value.error(failure);
        else if (stopped) value.close();
      },
      cancel() {
        stopped = true;
      },
    },
    {
      highWaterMark: maximumBufferedBytes,
      size: (chunk) => chunk.byteLength,
    },
  );
  return {
    readable,
    push(chunk) {
      if (stopped || controller === undefined) return true;
      if (controller.desiredSize === null || controller.desiredSize < chunk.byteLength)
        return false;
      try {
        controller.enqueue(chunk.slice());
        return true;
      } catch {
        stopped = true;
        return true;
      }
    },
    close() {
      if (stopped) return;
      stopped = true;
      try {
        controller?.close();
      } catch {
        // The consumer may have cancelled its side of the stream.
      }
    },
    error(error) {
      if (stopped) return;
      failure = error;
      stopped = true;
      try {
        controller?.error(error);
      } catch {
        // The consumer may have cancelled its side of the stream.
      }
    },
  };
};
