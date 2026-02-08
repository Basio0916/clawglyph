import { NextResponse } from "next/server";

export function jsonError(status: number, error: string, message: string): NextResponse {
  return NextResponse.json(
    {
      error,
      message
    },
    { status }
  );
}
