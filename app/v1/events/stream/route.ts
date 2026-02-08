import { NextRequest } from "next/server";
import {
  DEFAULT_STREAM_CATCHUP_LIMIT,
  createSseEvent,
  parseNonNegativeInt
} from "@/src/api-helpers";
import { jsonError } from "@/src/next-response";
import { getRuntime, subscribeEvents } from "@/src/runtime";
import { PixelEvent } from "@/src/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { config, store } = await getRuntime();
  const sinceIdResult = parseNonNegativeInt(
    request.nextUrl.searchParams.get("sinceId"),
    "sinceId"
  );
  if (sinceIdResult.error) {
    return jsonError(400, "invalid_query", sinceIdResult.error);
  }

  const encoder = new TextEncoder();
  let intervalHandle: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      const sendEvent = (eventName: string, payload: Record<string, unknown>) => {
        send(createSseEvent(eventName, payload));
      };

      const cleanup = () => {
        if (intervalHandle) {
          clearInterval(intervalHandle);
          intervalHandle = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // no-op
        }
      });

      sendEvent("hello", {
        serverTime: new Date().toISOString(),
        boardWidth: config.boardWidth,
        boardHeight: config.boardHeight
      });

      if (sinceIdResult.value !== null) {
        const catchup = await store.listPage({
          sinceId: String(sinceIdResult.value),
          limit: DEFAULT_STREAM_CATCHUP_LIMIT
        });
        if (catchup.events.length > 0) {
          sendEvent("events", {
            events: catchup.events,
            count: catchup.events.length,
            hasMore: catchup.hasMore,
            nextSinceId: catchup.nextSinceId
          });
        }
      }

      unsubscribe = subscribeEvents((events: PixelEvent[]) => {
        sendEvent("events", {
          events,
          count: events.length,
          lastEventId: events[events.length - 1]?.id ?? null
        });
      });

      intervalHandle = setInterval(() => {
        send(": keep-alive\n\n");
      }, 20_000);
    },
    cancel() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
