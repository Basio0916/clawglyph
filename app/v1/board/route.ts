import { NextResponse } from "next/server";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { config, store } = await getRuntime();
  const data = await store.buildBoardSnapshot(config.boardWidth, config.boardHeight);
  return NextResponse.json({ data });
}
