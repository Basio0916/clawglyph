import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_EVENT_PAGE_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  extractCreatedEvents,
  isValidAgentId,
  parseNonNegativeInt,
  parseOptionalAgentId,
  parsePositiveInt
} from "@/src/api-helpers";
import { createPixelEvent } from "@/src/pixel-service";
import { jsonError } from "@/src/next-response";
import { broadcastEvents, getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { store } = await getRuntime();
  const searchParams = request.nextUrl.searchParams;

  const sinceIdResult = parseNonNegativeInt(searchParams.get("sinceId"), "sinceId");
  if (sinceIdResult.error) {
    return jsonError(400, "invalid_query", sinceIdResult.error);
  }

  const limitResult = parsePositiveInt(searchParams.get("limit"), "limit", MAX_EVENT_PAGE_LIMIT);
  if (limitResult.error) {
    return jsonError(400, "invalid_query", limitResult.error);
  }
  const limit = limitResult.value ?? DEFAULT_EVENT_PAGE_LIMIT;

  const agentId = parseOptionalAgentId(searchParams.get("agentId"));
  if (agentId && !isValidAgentId(agentId)) {
    return jsonError(400, "invalid_query", "agentId must match ^[a-zA-Z0-9_-]{1,64}$");
  }

  const result = await store.listPage({
    sinceId: sinceIdResult.value !== null ? String(sinceIdResult.value) : undefined,
    agentId: agentId ?? undefined,
    limit
  });

  return NextResponse.json({
    data: result.events,
    page: {
      limit,
      hasMore: result.hasMore,
      nextSinceId: result.nextSinceId
    }
  });
}

export async function POST(request: NextRequest) {
  const { config, store } = await getRuntime();
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "invalid_payload", "request body must be valid json");
  }

  const result = await createPixelEvent(
    {
      authorizationHeader: request.headers.get("authorization") ?? undefined,
      agentIdHeader: request.headers.get("x-openclaw-agent-id") ?? undefined,
      knownLatestIdHeader:
        request.headers.get("x-openclaw-known-latest-id") ?? undefined,
      payload
    },
    config,
    store
  );

  const response = NextResponse.json(result.body, { status: result.status });
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      response.headers.set(key, value);
    }
  }

  if (result.status === 201) {
    broadcastEvents(extractCreatedEvents(result.body));
  }

  return response;
}
