import { CellCoordinate, PixelEvent } from "./types";

export const DEFAULT_EVENT_PAGE_LIMIT = 200;
export const MAX_EVENT_PAGE_LIMIT = 1000;
export const DEFAULT_STREAM_CATCHUP_LIMIT = 200;
export const MAX_CELL_QUERY_SIZE = 1000;
export const MAX_REGION_AREA = 1_000_000;

export function parsePositiveInt(
  raw: string | null,
  fieldName: string,
  max?: number
): { value: number | null; error: string | null } {
  if (raw === null) {
    return { value: null, error: null };
  }

  if (!/^[0-9]+$/.test(raw)) {
    return { value: null, error: `${fieldName} must be a positive integer` };
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { value: null, error: `${fieldName} must be a positive integer` };
  }

  if (typeof max === "number" && parsed > max) {
    return { value: null, error: `${fieldName} must be <= ${max}` };
  }

  return { value: parsed, error: null };
}

export function parseNonNegativeInt(
  raw: string | null,
  fieldName: string
): { value: number | null; error: string | null } {
  if (raw === null) {
    return { value: null, error: null };
  }

  if (!/^[0-9]+$/.test(raw)) {
    return { value: null, error: `${fieldName} must be an integer >= 0` };
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { value: null, error: `${fieldName} must be an integer >= 0` };
  }

  return { value: parsed, error: null };
}

export function parseBoundedCoordinate(
  raw: string | null,
  fieldName: string,
  max: number
): { value: number | null; error: string | null } {
  const parsed = parseNonNegativeInt(raw, fieldName);
  if (parsed.error || parsed.value === null) {
    return parsed;
  }
  if (parsed.value > max) {
    return { value: null, error: `${fieldName} must be between 0 and ${max}` };
  }
  return parsed;
}

export function parseOptionalAgentId(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

export function isValidAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(agentId);
}

export function readCoordinateArray(payload: unknown): {
  coordinates: CellCoordinate[] | null;
  error: string | null;
} {
  const rawCoordinates = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        "cells" in payload &&
        Array.isArray((payload as { cells?: unknown }).cells)
      ? ((payload as { cells: unknown[] }).cells as unknown[])
      : null;

  if (!rawCoordinates) {
    return {
      coordinates: null,
      error: "body must be an array of coordinates or an object with cells array"
    };
  }

  if (rawCoordinates.length === 0) {
    return {
      coordinates: null,
      error: "cells must not be empty"
    };
  }

  if (rawCoordinates.length > MAX_CELL_QUERY_SIZE) {
    return {
      coordinates: null,
      error: `up to ${MAX_CELL_QUERY_SIZE} coordinates are allowed`
    };
  }

  const coordinates: CellCoordinate[] = [];
  for (let index = 0; index < rawCoordinates.length; index += 1) {
    const item = rawCoordinates[index];
    if (typeof item !== "object" || item === null) {
      return {
        coordinates: null,
        error: `cells[${index}] must be an object`
      };
    }

    const x = (item as { x?: unknown }).x;
    const y = (item as { y?: unknown }).y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isInteger(x) ||
      !Number.isInteger(y)
    ) {
      return {
        coordinates: null,
        error: `cells[${index}] must contain integer x and y`
      };
    }

    coordinates.push({ x, y });
  }

  return { coordinates, error: null };
}

export function extractCreatedEvents(body: Record<string, unknown>): PixelEvent[] {
  const data = body.data;
  if (Array.isArray(data)) {
    return data as PixelEvent[];
  }
  if (data && typeof data === "object") {
    return [data as PixelEvent];
  }
  return [];
}

export function createSseEvent(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}
