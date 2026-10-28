export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/throw") throw new Error("raw program assets fetch failed");
    if (pathname === "/error")
      return new Response("raw program assets fetch failed", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "x-program-assets-response": "error" },
      });

    const requestBody = await request.text();
    const requestHeader = request.headers.get("x-program-assets-request") ?? "missing";
    const encoder = new TextEncoder();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk === 0) {
          controller.enqueue(encoder.encode(`${request.method}|${requestHeader}|${requestBody}|`));
          chunk++;
        } else if (chunk === 1) {
          controller.enqueue(encoder.encode("stream tail"));
          chunk++;
        } else controller.close();
      },
    });

    return new Response(body, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-program-assets-response": requestHeader,
      },
    });
  },
};
export * from "../../FixtureWorkerExports.ts";
