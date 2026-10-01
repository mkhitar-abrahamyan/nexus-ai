import type { NexusAI } from '../core/nexus.js';
import type { CompletionRequest } from '../types/messages.js';

/** Options for `createNexusRouteHandler()`. */
export interface NexusRouteHandlerOptions {
  /** The client that answers each request. */
  ai: NexusAI;
  /** Streams the answer as server-sent events instead of returning it whole. Off by default. */
  stream?: boolean;
}

/**
 * Creates a Next.js `POST` route handler that completes the posted request, or streams it as
 * server-sent events when streaming is on.
 */
export function createNexusRouteHandler(options: NexusRouteHandlerOptions) {
  return async function POST(request: Request): Promise<Response> {
    const body = (await request.json()) as CompletionRequest;

    if (options.stream || body.stream) {
      const stream = options.ai.stream({ ...body, stream: true });
      const encoder = new TextEncoder();

      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of stream) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) })}\n\n`,
                ),
              );
              controller.close();
            }
          },
          cancel() {
            stream.abort();
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        },
      );
    }

    const response = await options.ai.complete(body);
    return Response.json(response);
  };
}
