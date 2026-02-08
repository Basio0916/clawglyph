import { afterEach, describe, expect, test, vi } from "vitest";
import { AppConfig } from "../src/config";
import { createPixelEvent, registerAgent } from "../src/pixel-service";
import { InMemoryPixelStore } from "../src/store";

function baseConfig(): AppConfig {
  return {
    port: 3000,
    boardWidth: 8,
    boardHeight: 8,
    databaseUrl: "postgresql://example.invalid/test",
    agentPostIntervalMs: 0
  };
}

async function createAuthorizedStore(name = "writer-agent"): Promise<{
  store: InMemoryPixelStore;
  apiKey: string;
  agentId: string;
}> {
  const store = new InMemoryPixelStore();
  await store.initialize();
  const registered = await registerAgent({ name }, store);
  if (registered.status !== 201) {
    throw new Error("failed to register test agent");
  }
  const data = registered.body.data as { apiKey: string; agentId: string };
  return {
    store,
    apiKey: data.apiKey,
    agentId: data.agentId
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createPixelEvent", () => {
  test("returns 401 when token is missing", async () => {
    const result = await createPixelEvent(
      {
        authorizationHeader: undefined,
        agentIdHeader: "writer-agent",
        knownLatestIdHeader: undefined,
        payload: { x: 1, y: 1, glyph: "A", color: "#ff0000" }
      },
      baseConfig(),
      new InMemoryPixelStore()
    );
    expect(result.status).toBe(401);
  });

  test("returns 401 for unknown api key", async () => {
    const result = await createPixelEvent(
      {
        authorizationHeader: "Bearer invalid-token",
        agentIdHeader: undefined,
        knownLatestIdHeader: undefined,
        payload: { x: 1, y: 1, glyph: "A", color: "#ff0000" }
      },
      baseConfig(),
      new InMemoryPixelStore()
    );
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("unauthorized");
  });

  test("returns 400 for invalid payload", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore();
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: -1, y: 1, glyph: "", color: "red" }
      },
      baseConfig(),
      store
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_payload");
  });

  test("creates event for valid input", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore();
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: 1, y: 1, glyph: "🤖", color: "#0088ff" }
      },
      baseConfig(),
      store
    );
    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({
      id: "1",
      x: 1,
      y: 1,
      glyph: "🤖",
      color: "#0088ff",
      agentId
    });
    expect(result.body.count).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  test("creates event without x-openclaw-agent-id header", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore("Claw Writer");
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: undefined,
        knownLatestIdHeader: undefined,
        payload: { x: 2, y: 3, glyph: "🔥", color: "#ff6600" }
      },
      baseConfig(),
      store
    );

    expect(result.status).toBe(201);
    expect(result.body.count).toBe(1);
    expect(result.body.data).toMatchObject({
      x: 2,
      y: 3,
      glyph: "🔥",
      color: "#ff6600",
      agentId
    });
  });

  test("creates events from array payload", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore();
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: [
          { x: 1, y: 1, glyph: "A", color: "#111111" },
          { x: 2, y: 2, glyph: "B", color: "#222222" },
          { x: 3, y: 3, glyph: "C", color: "#333333" }
        ]
      },
      baseConfig(),
      store
    );

    expect(result.status).toBe(201);
    expect(result.body.count).toBe(3);
    expect(Array.isArray(result.body.data)).toBe(true);
    expect((result.body.data as unknown[]).length).toBe(3);
    expect(await store.list()).toHaveLength(3);
  });

  test("rejects payload larger than 100", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore();
    const payload = Array.from({ length: 101 }, (_, index) => ({
      x: index % 8,
      y: (index * 2) % 8,
      glyph: "X",
      color: "#123456"
    }));

    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload
      },
      baseConfig(),
      store
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("payload_too_large");
    expect(result.body.maxBatchSize).toBe(100);
  });

  test("rejects whole batch when one item is invalid", async () => {
    const { store, apiKey, agentId } = await createAuthorizedStore();
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: [
          { x: 1, y: 1, glyph: "A", color: "#111111" },
          { x: -1, y: 2, glyph: "B", color: "#222222" }
        ]
      },
      baseConfig(),
      store
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_payload");
    expect(await store.list()).toHaveLength(0);
  });

  test("rejects mismatched agent header for registered api key", async () => {
    const { store, apiKey } = await createAuthorizedStore("Claw Writer");
    const result = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: "other-agent",
        knownLatestIdHeader: undefined,
        payload: { x: 2, y: 3, glyph: "A", color: "#112233" }
      },
      baseConfig(),
      store
    );

    expect(result.status).toBe(403);
    expect(result.body.error).toBe("forbidden_agent");
  });

  test("returns 429 when posting within configured interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T00:00:00.000Z"));

    const config = baseConfig();
    config.agentPostIntervalMs = 60_000;
    const { store, apiKey, agentId } = await createAuthorizedStore();

    const first = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: 1, y: 1, glyph: "A", color: "#101010" }
      },
      config,
      store
    );
    expect(first.status).toBe(201);

    vi.setSystemTime(new Date("2026-02-08T00:00:30.000Z"));

    const second = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: 2, y: 2, glyph: "B", color: "#202020" }
      },
      config,
      store
    );

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(second.headers?.["retry-after"]).toBe("30");
  });

  test("returns 409 when precondition detects changed target cell", async () => {
    const config = baseConfig();
    const { store, apiKey, agentId } = await createAuthorizedStore();

    const first = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: 4, y: 4, glyph: "A", color: "#333333" }
      },
      config,
      store
    );
    expect(first.status).toBe(201);

    const conflicting = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: "0",
        payload: { x: 4, y: 4, glyph: "B", color: "#444444" }
      },
      config,
      store
    );

    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error).toBe("precondition_failed");
  });

  test("accepts post when knownLatestId still matches target cells", async () => {
    const config = baseConfig();
    const { store, apiKey, agentId } = await createAuthorizedStore();

    const first = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: undefined,
        payload: { x: 0, y: 0, glyph: "A", color: "#555555" }
      },
      config,
      store
    );
    expect(first.status).toBe(201);

    const second = await createPixelEvent(
      {
        authorizationHeader: `Bearer ${apiKey}`,
        agentIdHeader: agentId,
        knownLatestIdHeader: "1",
        payload: { x: 1, y: 0, glyph: "B", color: "#666666" }
      },
      config,
      store
    );

    expect(second.status).toBe(201);
    expect(second.body.count).toBe(1);
  });
});
