export const withSignal = (request: Request, signal: AbortSignal) =>
  new Request(request, { signal: AbortSignal.any([request.signal, signal]) });
