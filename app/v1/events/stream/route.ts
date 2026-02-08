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
export const maxDuration = 300;

function readStreamPollIntervalMs(): number {
  const raw = process.env.SSE_DB_POLL_INTERVAL_MS;
  if (!raw) {
    return 1200;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 300 || parsed > 60_000) {
    return 1200;
  }
  return parsed;
}

const STREAM_POLL_INTERVAL_MS = readStreamPollIntervalMs();
const STREAM_MAX_POLL_PAGES_PER_TICK = 3;

function parseEventId(raw: string | number | null | undefined): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    return -1;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function filterEventsAfterCursor(
  events: PixelEvent[],
  cursor: number
): { events: PixelEvent[]; cursor: number } {
  const ordered = events
    .map((event) => ({ event, id: parseEventId(event.id) }))
    .filter((entry) => entry.id > cursor)
    .sort((left, right) => left.id - right.id);

  const unique: PixelEvent[] = [];
  let nextCursor = cursor;
  for (const entry of ordered) {
    if (entry.id <= nextCursor) {
      continue;
    }
    unique.push(entry.event);
    nextCursor = entry.id;
  }

  return { events: unique, cursor: nextCursor };
}

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
  let keepAliveHandle: NodeJS.Timeout | null = null;
  let pollingHandle: NodeJS.Timeout | null = null;
  let pollingInFlight = false;
  let unsubscribe: (() => void) | null = null;
  const initialStats = await store.getEventStats();
  let cursor =
    sinceIdResult.value !== null
      ? sinceIdResult.value
      : Math.max(0, parseEventId(initialStats.latestEventId));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      const sendEvent = (eventName: string, payload: Record<string, unknown>) => {
        send(createSseEvent(eventName, payload));
      };

      const cleanup = () => {
        if (keepAliveHandle) {
          clearInterval(keepAliveHandle);
          keepAliveHandle = null;
        }
        if (pollingHandle) {
          clearInterval(pollingHandle);
          pollingHandle = null;
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
          sinceId: String(cursor),
          limit: DEFAULT_STREAM_CATCHUP_LIMIT
        });
        const filtered = filterEventsAfterCursor(catchup.events, cursor);
        cursor = filtered.cursor;
        if (filtered.events.length > 0) {
          sendEvent("events", {
            events: filtered.events,
            count: filtered.events.length,
            hasMore: catchup.hasMore,
            nextSinceId: catchup.nextSinceId
          });
        }
      }

      unsubscribe = subscribeEvents((events: PixelEvent[]) => {
        const filtered = filterEventsAfterCursor(events, cursor);
        cursor = filtered.cursor;
        if (filtered.events.length === 0) {
          return;
        }
        sendEvent("events", {
          events: filtered.events,
          count: filtered.events.length,
          lastEventId: filtered.events[filtered.events.length - 1]?.id ?? null
        });
      });

      pollingHandle = setInterval(async () => {
        if (pollingInFlight) {
          return;
        }
        pollingInFlight = true;
        try {
          const stats = await store.getEventStats();
          const latestEventId = parseEventId(stats.latestEventId);
          if (latestEventId <= cursor) {
            return;
          }

          for (let pageCount = 0; pageCount < STREAM_MAX_POLL_PAGES_PER_TICK; pageCount += 1) {
            const page = await store.listPage({
              sinceId: String(cursor),
              limit: DEFAULT_STREAM_CATCHUP_LIMIT
            });
            const filtered = filterEventsAfterCursor(page.events, cursor);
            cursor = filtered.cursor;

            if (filtered.events.length > 0) {
              sendEvent("events", {
                events: filtered.events,
                count: filtered.events.length,
                hasMore: page.hasMore,
                nextSinceId: page.nextSinceId
              });
            }

            if (!page.hasMore) {
              break;
            }

            const nextSinceId = parseEventId(page.nextSinceId);
            if (nextSinceId <= cursor && filtered.events.length === 0) {
              break;
            }
          }
        } catch {
          // keep stream alive and retry on next tick
        } finally {
          pollingInFlight = false;
        }
      }, STREAM_POLL_INTERVAL_MS);

      keepAliveHandle = setInterval(() => {
        send(": keep-alive\n\n");
      }, 20_000);
    },
    cancel() {
      if (keepAliveHandle) {
        clearInterval(keepAliveHandle);
        keepAliveHandle = null;
      }
      if (pollingHandle) {
        clearInterval(pollingHandle);
        pollingHandle = null;
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
