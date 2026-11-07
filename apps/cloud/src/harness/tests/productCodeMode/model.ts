export const CODE_MODE_SOURCE =
  'const r = await tools.exec_command({cmd:"mkdir -p docs/routines/evening","workdir":"/work","yield_time_ms":10000,"max_output_tokens":1000}); text(r.output);';

export const OUTPUT_SOURCE =
  'const r = await tools.exec_command({cmd:"printf code-mode-output","workdir":"/work","yield_time_ms":10000,"max_output_tokens":1000}); text(r.output);';

export function codeModeResponses() {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    async fetch(request: Request) {
      const body: Record<string, unknown> = await request.json();
      requests.push(body);
      const id = `response-${requests.length}`;
      const item =
        requests.length === 1
          ? {
              type: "custom_tool_call",
              id: "item-code-mode",
              call_id: "call-code-mode",
              name: "exec",
              input: CODE_MODE_SOURCE,
            }
          : requests.length === 2
            ? {
                type: "custom_tool_call",
                id: "item-output",
                call_id: "call-output",
                name: "exec",
                input: OUTPUT_SOURCE,
              }
            : {
                type: "message",
                id: "message-done",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Routine directory created." }],
              };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  };
}
