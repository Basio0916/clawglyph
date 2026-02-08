import { NextResponse } from "next/server";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { store } = await getRuntime();
  const data = await store.listAgents();
  return NextResponse.json({ data });
}
