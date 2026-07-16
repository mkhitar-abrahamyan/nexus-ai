import type { NexusAI } from '../core/nexus.js';
import type { CompletionRequest } from '../types/messages.js';

export interface NexusRouteHandlerOptions {
  ai: NexusAI;
  stream?: boolean;
}

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
