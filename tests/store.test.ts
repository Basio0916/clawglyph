import { describe, expect, test } from "vitest";
import { InMemoryPixelStore } from "../src/store";

describe("InMemoryPixelStore", () => {
  test("returns latest value for same cell in board snapshot", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    await store.addMany([{ x: 2, y: 3, glyph: "A", color: "#000000" }], "writer");
    await store.addMany([{ x: 2, y: 3, glyph: "B", color: "#ffffff" }], "writer");

    const board = await store.buildBoardSnapshot(8, 8);
    expect(board.totalEvents).toBe(2);
    expect(board.cells).toHaveLength(1);
    expect(board.cells[0]).toMatchObject({
      x: 2,
      y: 3,
      glyph: "B",
      color: "#ffffff",
      eventId: "2"
    });
  });

  test("filters events with sinceId", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    await store.addMany([{ x: 0, y: 0, glyph: "1", color: "#111111" }], "writer");
    await store.addMany([{ x: 1, y: 1, glyph: "2", color: "#222222" }], "writer");

    const events = await store.list("1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "2", glyph: "2" });
  });

  test("registers agent and hides api key in list", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    const agent = await store.registerAgent("My Agent", "for tests");
    const resolved = await store.findAgentByApiKey(agent.apiKey);
    const list = await store.listAgents();

    expect(resolved?.agentId).toBe(agent.agentId);
    expect(agent.agentId).toBe("my-agent");
    expect(list[0]).toMatchObject({
      agentId: "my-agent",
      apiKey: "[REDACTED]"
    });
  });

  test("supports paginated event list with cursor", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    await store.addMany([{ x: 0, y: 0, glyph: "1", color: "#111111" }], "writer");
    await store.addMany([{ x: 1, y: 1, glyph: "2", color: "#222222" }], "writer");
    await store.addMany([{ x: 2, y: 2, glyph: "3", color: "#333333" }], "writer");

    const page1 = await store.listPage({ limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextSinceId).toBe("2");

    const page2 = await store.listPage({ sinceId: page1.nextSinceId ?? undefined, limit: 2 });
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0].id).toBe("3");
    expect(page2.hasMore).toBe(false);
  });

  test("builds region snapshot and cell query results", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    await store.addMany(
      [
        { x: 1, y: 1, glyph: "A", color: "#aaaaaa" },
        { x: 5, y: 5, glyph: "B", color: "#bbbbbb" }
      ],
      "writer"
    );

    const region = await store.buildBoardRegionSnapshot(0, 0, 4, 4);
    expect(region.cells).toHaveLength(1);
    expect(region.cells[0]).toMatchObject({ x: 1, y: 1, glyph: "A" });

    const queried = await store.queryBoardCells([
      { x: 1, y: 1 },
      { x: 9, y: 9 }
    ]);
    expect(queried).toHaveLength(2);
    expect(queried[0].cell?.glyph).toBe("A");
    expect(queried[1].cell).toBeNull();
  });

  test("returns event stats and latest event timestamp by agent", async () => {
    const store = new InMemoryPixelStore();
    await store.initialize();
    await store.addMany([{ x: 0, y: 0, glyph: "A", color: "#111111" }], "writer-1");
    await store.addMany([{ x: 1, y: 1, glyph: "B", color: "#222222" }], "writer-2");

    const stats = await store.getEventStats();
    expect(stats).toMatchObject({
      totalEvents: 2,
      latestEventId: "2"
    });

    const writer1Latest = await store.getLatestEventAtByAgent("writer-1");
    const missingLatest = await store.getLatestEventAtByAgent("missing-agent");
    expect(typeof writer1Latest).toBe("string");
    expect(missingLatest).toBeNull();
  });
});
