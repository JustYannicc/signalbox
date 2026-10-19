import { MockHttpSocket } from "./MockHttpSocket.mjs";

const ERRNO = Object.freeze({
  SUCCESS: 0,
  AGAIN: 6,
  BADF: 8,
  AFNOSUPPORT: 5,
  FAULT: 21,
  HOSTUNREACH: 23,
  INVAL: 28,
  IO: 29,
  MSGSIZE: 35,
  NOTCONN: 53,
  NOTSOCK: 57,
  NOTSUP: 58,
});

const AF_INET = 1;
const SOCK_STREAM = 6;
const SOL_SOCKET = 1;
const SO_RCVTIMEO = 20;

class ImportError extends Error {
  constructor(errno, message) {
    super(message);
    this.errno = errno;
  }
}

function fail(errno, message) {
  throw new ImportError(errno, message);
}

function asU32(value) {
  if (!Number.isInteger(value)) fail(ERRNO.INVAL, "Expected a wasm i32 value");
  return value >>> 0;
}

function memoryView(memory, pointer, length) {
  const offset = asU32(pointer);
  const size = asU32(length);
  if (offset + size > memory.buffer.byteLength) {
    fail(ERRNO.FAULT, "Wasm memory range is out of bounds");
  }
  return { offset, size };
}

function readBytes(memory, pointer, length) {
  const { offset, size } = memoryView(memory, pointer, length);
  return new Uint8Array(memory.buffer, offset, size).slice();
}

function writeU32(memory, pointer, value) {
  const { offset } = memoryView(memory, pointer, 4);
  new DataView(memory.buffer).setUint32(offset, value >>> 0, true);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(ERRNO.INVAL, "Expected UTF-8 input");
  }
}

function descriptorErrno(error) {
  if (error instanceof ImportError) return error.errno;
  if (error && Number.isInteger(error.errno)) return error.errno;
  switch (error && error.code) {
    case "EBADF":
      return ERRNO.BADF;
    case "EINVAL":
      return ERRNO.INVAL;
    case "EMFILE":
      return 33;
    default:
      return ERRNO.IO;
  }
}

export function createMockHttpAdapter({ memory, descriptors, mock }) {
  if (typeof memory !== "function") throw new TypeError("memory must be a function");
  if (
    !descriptors ||
    typeof descriptors.register !== "function" ||
    typeof descriptors.resource !== "function" ||
    typeof descriptors.close !== "function"
  ) {
    throw new TypeError("descriptors must expose register, resource, and close");
  }
  if (!mock || typeof mock.respond !== "function") {
    throw new TypeError("mock must expose respond");
  }

  function currentMemory() {
    let value;
    try {
      value = memory();
    } catch {
      fail(ERRNO.IO, "Guest memory is unavailable");
    }
    if (!(value instanceof WebAssembly.Memory)) fail(ERRNO.IO, "Guest memory is unavailable");
    return value;
  }

  function socketFor(fdValue) {
    let resource;
    try {
      const fd = asU32(fdValue);
      if (fd > 0x7fffffff) fail(ERRNO.BADF, "Invalid descriptor");
      resource = descriptors.resource(fd);
    } catch (error) {
      if (error instanceof ImportError) throw error;
      fail(descriptorErrno(error), "Invalid descriptor");
    }
    if (!(resource instanceof MockHttpSocket)) {
      fail(ERRNO.NOTSOCK, "Descriptor is not a mock HTTP socket");
    }
    return resource;
  }

  function guarded(operation) {
    try {
      return operation();
    } catch (error) {
      return descriptorErrno(error);
    }
  }

  const imports = Object.freeze({
    net_socket: (domain, sockType, protocol, retFdPointer) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        const { offset } = memoryView(wasmMemory, retFdPointer, 4);
        if (domain !== AF_INET) fail(ERRNO.AFNOSUPPORT, "Only AgentOS AF_INET is supported");
        if (sockType !== SOCK_STREAM || protocol !== 0) {
          fail(ERRNO.NOTSUP, "Only AgentOS SOCK_STREAM with the default protocol is supported");
        }
        const resource = new MockHttpSocket();
        let fd;
        try {
          fd = descriptors.register(resource);
          if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
            fail(ERRNO.IO, "Shared descriptor registry returned an invalid fd");
          }
          writeU32(wasmMemory, offset, fd);
          return ERRNO.SUCCESS;
        } catch (error) {
          if (Number.isInteger(fd)) {
            try {
              descriptors.close(fd);
            } catch {
              resource.close();
            }
          } else {
            resource.close();
          }
          throw error;
        }
      }),

    net_connect: (fd, addressPointer, addressLength) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        const address = decodeUtf8(readBytes(wasmMemory, addressPointer, addressLength));
        socketFor(fd).connect(address);
        return ERRNO.SUCCESS;
      }),

    net_send: (fd, bufferPointer, bufferLength, flags, retSentPointer) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        memoryView(wasmMemory, retSentPointer, 4);
        if (flags !== 0) fail(ERRNO.NOTSUP, "Send flags are unsupported");
        const bytes = readBytes(wasmMemory, bufferPointer, bufferLength);
        const count = socketFor(fd).send(bytes, mock);
        writeU32(wasmMemory, retSentPointer, count);
        return ERRNO.SUCCESS;
      }),

    net_recv: (fd, bufferPointer, bufferLength, flags, retReceivedPointer) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        memoryView(wasmMemory, retReceivedPointer, 4);
        const { offset, size } = memoryView(wasmMemory, bufferPointer, bufferLength);
        if (flags !== 0) fail(ERRNO.NOTSUP, "Receive flags are unsupported");
        writeU32(wasmMemory, retReceivedPointer, 0);
        const output = new Uint8Array(wasmMemory.buffer, offset, size);
        const count = socketFor(fd).read(output);
        writeU32(wasmMemory, retReceivedPointer, count);
        return ERRNO.SUCCESS;
      }),

    net_close: (fd) =>
      guarded(() => {
        socketFor(fd);
        descriptors.close(asU32(fd));
        return ERRNO.SUCCESS;
      }),

    net_getaddrinfo: (
      hostPointer,
      hostLength,
      portPointer,
      portLength,
      family,
      retAddressPointer,
      retAddressLengthPointer,
    ) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        const lengthOffset = memoryView(wasmMemory, retAddressLengthPointer, 4).offset;
        const host = decodeUtf8(readBytes(wasmMemory, hostPointer, hostLength));
        const port = decodeUtf8(readBytes(wasmMemory, portPointer, portLength));
        if (family !== 0 && family !== 4) {
          fail(ERRNO.NOTSUP, "Only IPv4 address lookup is supported");
        }
        if (host !== "mock.invalid" || port !== "80") {
          fail(ERRNO.HOSTUNREACH, "Only mock.invalid:80 is available");
        }
        const address = new TextEncoder().encode("mock.invalid:80");
        const capacity = new DataView(wasmMemory.buffer).getUint32(lengthOffset, true);
        if (capacity < address.byteLength) {
          writeU32(wasmMemory, retAddressLengthPointer, address.byteLength);
          return ERRNO.MSGSIZE;
        }
        const { offset } = memoryView(wasmMemory, retAddressPointer, address.byteLength);
        new Uint8Array(wasmMemory.buffer, offset, address.byteLength).set(address);
        writeU32(wasmMemory, retAddressLengthPointer, address.byteLength);
        return ERRNO.SUCCESS;
      }),

    net_tls_connect: (_fd, _hostnamePointer, _hostnameLength) => ERRNO.NOTSUP,

    net_setsockopt: (fd, level, optname, valuePointer, valueLength) =>
      guarded(() => {
        const wasmMemory = currentMemory();
        const value = readBytes(wasmMemory, valuePointer, valueLength);
        if (level !== SOL_SOCKET || optname !== SO_RCVTIMEO) {
          fail(ERRNO.NOTSUP, "Only SO_RCVTIMEO is supported");
        }
        socketFor(fd).setReceiveTimeout(value);
        return ERRNO.SUCCESS;
      }),

    net_getsockname: (_fd, _retAddressPointer, _retAddressLengthPointer) => ERRNO.NOTSUP,
    net_getpeername: (_fd, _retAddressPointer, _retAddressLengthPointer) => ERRNO.NOTSUP,
    net_poll: (_fdsPointer, _nfds, _timeoutMs, _retReadyPointer) => ERRNO.NOTSUP,
    net_bind: (_fd, _addressPointer, _addressLength) => ERRNO.NOTSUP,
    net_listen: (_fd, _backlog) => ERRNO.NOTSUP,
    net_accept: (_fd, _retFdPointer, _retAddressPointer, _retAddressLengthPointer) => ERRNO.NOTSUP,
    net_sendto: (
      _fd,
      _bufferPointer,
      _bufferLength,
      _flags,
      _addressPointer,
      _addressLength,
      _retSentPointer,
    ) => ERRNO.NOTSUP,
    net_recvfrom: (
      _fd,
      _bufferPointer,
      _bufferLength,
      _flags,
      _retReceivedPointer,
      _retAddressPointer,
      _retAddressLengthPointer,
    ) => ERRNO.NOTSUP,

    net_validate_socket: (fd) =>
      guarded(() => {
        socketFor(fd);
        return ERRNO.SUCCESS;
      }),
  });

  return Object.freeze({
    imports,
    getImportObject() {
      return { host_net: imports };
    },
  });
}
