import { describe, expect, test } from "vitest";
import { validateAgentId, validatePixelPlacement } from "../src/validation";

describe("validatePixelPlacement", () => {
  test("accepts valid payload", () => {
    const errors = validatePixelPlacement(
      { x: 1, y: 2, glyph: "😀", color: "#ff0099" },
      16,
      16
    );
    expect(errors).toEqual([]);
  });

  test("rejects out of range coordinates", () => {
    const errors = validatePixelPlacement(
      { x: 20, y: -1, glyph: "A", color: "#ffffff" },
      10,
      10
    );
    expect(errors.map((e) => e.field).sort()).toEqual(["x", "y"]);
  });

  test("rejects invalid color format", () => {
    const errors = validatePixelPlacement(
      { x: 0, y: 0, glyph: "A", color: "red" },
      10,
      10
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("color");
  });
});

describe("validateAgentId", () => {
  test("rejects empty agent id", () => {
    expect(validateAgentId(undefined)).toContain("required");
  });

  test("accepts agent id in allowed pattern", () => {
    expect(validateAgentId("writer_agent-01")).toBeNull();
  });
});
