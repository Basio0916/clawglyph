import { NextRequest, NextResponse } from "next/server";
import {
  MAX_REGION_AREA,
  parseBoundedCoordinate,
  parsePositiveInt
} from "@/src/api-helpers";
import { jsonError } from "@/src/next-response";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { config, store } = await getRuntime();
  const searchParams = request.nextUrl.searchParams;

  const xResult = parseBoundedCoordinate(searchParams.get("x"), "x", config.boardWidth - 1);
  const yResult = parseBoundedCoordinate(searchParams.get("y"), "y", config.boardHeight - 1);
  const wResult = parsePositiveInt(searchParams.get("w"), "w");
  const hResult = parsePositiveInt(searchParams.get("h"), "h");

  const errors = [xResult.error, yResult.error, wResult.error, hResult.error].filter(
    Boolean
  );
  if (errors.length > 0) {
    return jsonError(400, "invalid_query", errors[0] as string);
  }

  if (
    xResult.value === null ||
    yResult.value === null ||
    wResult.value === null ||
    hResult.value === null
  ) {
    return jsonError(400, "invalid_query", "x, y, w, h are required");
  }

  const x = xResult.value;
  const y = yResult.value;
  const w = wResult.value;
  const h = hResult.value;

  if (x + w > config.boardWidth || y + h > config.boardHeight) {
    return jsonError(400, "invalid_query", "region exceeds board bounds");
  }

  if (w * h > MAX_REGION_AREA) {
    return jsonError(400, "region_too_large", `region area must be <= ${MAX_REGION_AREA}`);
  }

  const [data, stats] = await Promise.all([
    store.buildBoardRegionSnapshot(x, y, w, h),
    store.getEventStats()
  ]);

  return NextResponse.json({
    data: {
      ...data,
      latestEventId: stats.latestEventId
    }
  });
}
