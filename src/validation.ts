import { PixelPlacementInput } from "./types";

export interface ValidationError {
  field: keyof PixelPlacementInput;
  message: string;
}

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function countGraphemes(value: string): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value).length;
}

export function validatePixelPlacement(
  input: unknown,
  boardWidth: number,
  boardHeight: number
): ValidationError[] {
  if (typeof input !== "object" || input === null) {
    return [{ field: "x", message: "request body must be an object" }];
  }

  const payload = input as Partial<PixelPlacementInput>;
  const errors: ValidationError[] = [];
  const x = payload.x;
  const y = payload.y;

  if (typeof x !== "number" || !Number.isInteger(x)) {
    errors.push({ field: "x", message: "x must be an integer" });
  } else if (x < 0 || x >= boardWidth) {
    errors.push({
      field: "x",
      message: `x must be between 0 and ${boardWidth - 1}`
    });
  }

  if (typeof y !== "number" || !Number.isInteger(y)) {
    errors.push({ field: "y", message: "y must be an integer" });
  } else if (y < 0 || y >= boardHeight) {
    errors.push({
      field: "y",
      message: `y must be between 0 and ${boardHeight - 1}`
    });
  }

  if (typeof payload.glyph !== "string" || payload.glyph.trim().length === 0) {
    errors.push({ field: "glyph", message: "glyph is required" });
  } else if (countGraphemes(payload.glyph) > 8) {
    errors.push({
      field: "glyph",
      message: "glyph must contain at most 8 graphemes"
    });
  }

  if (typeof payload.color !== "string" || !COLOR_PATTERN.test(payload.color)) {
    errors.push({
      field: "color",
      message: "color must be a hex value like #RRGGBB or #RRGGBBAA"
    });
  }

  return errors;
}

export function validateAgentId(agentId: string | undefined): string | null {
  if (!agentId) {
    return "x-openclaw-agent-id header is required";
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
    return "x-openclaw-agent-id must match ^[a-zA-Z0-9_-]{1,64}$";
  }
  return null;
}
