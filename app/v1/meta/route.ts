import { NextResponse } from "next/server";
import {
  MAX_CELL_QUERY_SIZE,
  MAX_EVENT_PAGE_LIMIT,
  MAX_REGION_AREA
} from "@/src/api-helpers";
import { MAX_BATCH_SIZE } from "@/src/pixel-service";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { config, store } = await getRuntime();
  const stats = await store.getEventStats();

  return NextResponse.json({
    data: {
      board: {
        width: config.boardWidth,
        height: config.boardHeight
      },
      limits: {
        maxBatchSize: MAX_BATCH_SIZE,
        maxEventPageLimit: MAX_EVENT_PAGE_LIMIT,
        maxCellQuerySize: MAX_CELL_QUERY_SIZE,
        maxRegionArea: MAX_REGION_AREA,
        agentPostIntervalMs: config.agentPostIntervalMs
      },
      events: stats,
      capabilities: {
        eventDelta: true,
        regionQuery: true,
        cellQuery: true,
        conditionalPost: true,
        sse: true
      },
      serverTime: new Date().toISOString()
    }
  });
}
