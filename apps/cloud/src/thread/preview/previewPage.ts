export const PREVIEW_VIEW_PATH = "/__signalbox_preview/lease";
export const PREVIEW_SCRIPT_PATH = "/__signalbox_preview/client.js";

/** The tab owns its lease even when the dev server has no HMR connection. */
const client = `(() => {
  if (window.__signalboxPreviewLease) return;
  window.__signalboxPreviewLease = true;
  const starting = document.documentElement.dataset.signalboxStarting === "true";
  const message = document.querySelector("[data-preview-message]");
  const retry = document.querySelector("[data-preview-retry]");
  let socket, heartbeat, reconnect, deadline;
  let leaving = false;
  let failed = false;
  const fail = (text) => {
    failed = true;
    clearTimeout(deadline);
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    if (message) message.textContent = text;
    if (retry) retry.hidden = false;
    socket?.close(1000);
  };
  const connect = () => {
    if (leaving || failed) return;
    socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "${PREVIEW_VIEW_PATH}");
    socket.onopen = () => { heartbeat = setInterval(() => socket.send("view"), 25000); };
    socket.onmessage = (event) => {
      if (event.data === "ready" && starting) location.reload();
      if (event.data === "failed") fail("The preview could not start. Try again.");
    };
    socket.onclose = (event) => {
      clearInterval(heartbeat);
      if (leaving || failed) return;
      if (event.code >= 4000) return fail("The preview could not start. Try again.");
      reconnect = setTimeout(connect, 2000);
    };
  };
  retry?.addEventListener("click", () => location.reload());
  addEventListener("pagehide", () => {
    leaving = true;
    clearTimeout(reconnect);
    clearTimeout(deadline);
    clearInterval(heartbeat);
    socket?.close(1000);
  });
  addEventListener("pageshow", (event) => { if (event.persisted) { leaving = false; connect(); } });
  if (starting) deadline = setTimeout(() => fail("The preview is taking too long. Try again."), 180000);
  connect();
})();`;

export const previewScript = () =>
  new Response(client, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });

export const startingPreview = () =>
  new Response(
    `<!doctype html><html lang="en" data-signalbox-starting="true"><head>` +
      `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="color-scheme" content="light dark"><title>Starting preview · Signalbox</title>` +
      `<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:15px/1.5 system-ui;background:light-dark(#fafafa,#171717);color:light-dark(#242424,#eee)}main{padding:2rem;max-width:32rem}p{margin:0}button{margin-top:1rem;padding:.5rem .9rem;font:inherit;cursor:pointer}</style>` +
      `</head><body><main><p role="status" data-preview-message>Starting preview…</p>` +
      `<button type="button" data-preview-retry hidden>Try again</button><noscript>Enable JavaScript to open this preview.</noscript></main>` +
      `<script src="${PREVIEW_SCRIPT_PATH}" defer></script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

export const withPreviewLease = (response: Response) => {
  if (
    !response.headers.get("content-type")?.toLowerCase().includes("text/html") ||
    response.body === null
  )
    return response;
  return new HTMLRewriter()
    .on("head", {
      element: (element) => {
        element.prepend(`<script src="${PREVIEW_SCRIPT_PATH}" defer></script>`, { html: true });
      },
    })
    .transform(response);
};

export const previewOpenPath = (threadId: string, port: number) =>
  `/api/cloud/threads/${encodeURIComponent(threadId)}/previews/${port}`;
