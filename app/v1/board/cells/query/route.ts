import { NextRequest, NextResponse } from "next/server";
import { readCoordinateArray } from "@/src/api-helpers";
import { jsonError } from "@/src/next-response";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { config, store } = await getRuntime();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "invalid_payload", "request body must be valid json");
  }

  const parsed = readCoordinateArray(payload);
  if (parsed.error || !parsed.coordinates) {
    return jsonError(400, "invalid_payload", parsed.error ?? "invalid payload");
  }

  const outOfRange = parsed.coordinates.find(
    (coordinate) =>
      coordinate.x < 0 ||
      coordinate.x >= config.boardWidth ||
      coordinate.y < 0 ||
      coordinate.y >= config.boardHeight
  );
  if (outOfRange) {
    return jsonError(400, "invalid_payload", "all coordinates must be inside board bounds");
  }

  const [results, stats] = await Promise.all([
    store.queryBoardCells(parsed.coordinates),
    store.getEventStats()
  ]);

  const found = results.reduce((count, item) => count + (item.cell ? 1 : 0), 0);

  return NextResponse.json({
    data: {
      requested: parsed.coordinates.length,
      found,
      latestEventId: stats.latestEventId,
      results
    }
  });
}
