import { NextRequest, NextResponse } from "next/server";
import { registerAgent, RegisterAgentInput } from "@/src/pixel-service";
import { getRuntime } from "@/src/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { store } = await getRuntime();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const result = await registerAgent((payload ?? {}) as RegisterAgentInput, store);
  if (result.status !== 201) {
    return NextResponse.json(result.body, { status: result.status });
  }

  const origin = request.nextUrl.origin;
  return NextResponse.json(
    {
      ...result.body,
      instructions: {
        skillUrl: `${origin}/skill.md`,
        heartbeatUrl: `${origin}/heartbeat.md`,
        postUrl: `${origin}/v1/pixel-events`
      }
    },
    { status: 201 }
  );
}
