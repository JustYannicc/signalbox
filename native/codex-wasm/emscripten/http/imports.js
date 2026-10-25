// These declarations satisfy emcc, while the loader supplies real host_net imports.
// Missing host support must fail; none of these declarations performs network I/O.
addToLibrary({
  net_socket: function () {
    throw new Error("Unsupported HTTP host_net.net_socket");
  },
  net_connect: function () {
    throw new Error("Unsupported HTTP host_net.net_connect");
  },
  net_send: function () {
    throw new Error("Unsupported HTTP host_net.net_send");
  },
  net_recv: function () {
    throw new Error("Unsupported HTTP host_net.net_recv");
  },
  net_close: function () {
    throw new Error("Unsupported HTTP host_net.net_close");
  },
  net_tls_connect: function () {
    throw new Error("Unsupported HTTP host_net.net_tls_connect");
  },
  net_setsockopt: function () {
    throw new Error("Unsupported HTTP host_net.net_setsockopt");
  },
});
