import path from "node:path";
import express from "express";
import { AppConfig } from "./config";
import { NeonPixelStore } from "./neon-store";
import { createPixelEvent, MAX_BATCH_SIZE, registerAgent } from "./pixel-service";
import { PixelStore } from "./store";
import { CellCoordinate, PixelEvent } from "./types";

export interface CreateAppOptions {
  config: AppConfig;
  store?: PixelStore;
}

const DEFAULT_EVENT_PAGE_LIMIT = 200;
const MAX_EVENT_PAGE_LIMIT = 1000;
const DEFAULT_STREAM_CATCHUP_LIMIT = 200;
const MAX_CELL_QUERY_SIZE = 1000;
const MAX_REGION_AREA = 1_000_000;

function parsePositiveInt(
  raw: string | undefined,
  fieldName: string,
  max?: number
): { value: number | null; error: string | null } {
  if (typeof raw === "undefined") {
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

function parseNonNegativeInt(
  raw: string | undefined,
  fieldName: string
): { value: number | null; error: string | null } {
  if (typeof raw === "undefined") {
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

function parseBoundedCoordinate(
  raw: string | undefined,
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

function parseOptionalAgentId(raw: string | undefined): string | null {
  if (typeof raw === "undefined" || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(agentId);
}

function readCoordinateArray(payload: unknown): {
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
    if (typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y)) {
      return {
        coordinates: null,
        error: `cells[${index}] must contain integer x and y`
      };
    }

    coordinates.push({ x, y });
  }

  return { coordinates, error: null };
}

function setServiceHeaders(res: express.Response, headers: Record<string, string> | undefined): void {
  if (!headers) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function writeSseEvent(
  res: express.Response,
  eventName: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractCreatedEvents(body: Record<string, unknown>): PixelEvent[] {
  const data = body.data;
  if (Array.isArray(data)) {
    return data as PixelEvent[];
  }
  if (data && typeof data === "object") {
    return [data as PixelEvent];
  }
  return [];
}

function wrapAsync(
  handler: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => Promise<void | express.Response>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

export async function createApp(options: CreateAppOptions) {
  const { config } = options;
  const store = options.store ?? new NeonPixelStore(config.databaseUrl);
  await store.initialize();
  const sseClients = new Map<number, express.Response>();
  let nextSseClientId = 1;

  function broadcastEvents(events: PixelEvent[]): void {
    if (events.length === 0) {
      return;
    }

    const payload = {
      events,
      count: events.length,
      lastEventId: events[events.length - 1].id
    };

    for (const [clientId, client] of sseClients.entries()) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(clientId);
        continue;
      }
      writeSseEvent(client, "events", payload);
    }
  }

  const app = express();
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/v1/pixel-events", wrapAsync(async (req, res) => {
    const sinceIdRaw = typeof req.query.sinceId === "string" ? req.query.sinceId : undefined;
    const sinceIdResult = parseNonNegativeInt(sinceIdRaw, "sinceId");
    if (sinceIdResult.error) {
      return res.status(400).json({
        error: "invalid_query",
        message: sinceIdResult.error
      });
    }

    const limitRaw = typeof req.query.limit === "string" ? req.query.limit : undefined;
    const limitResult = parsePositiveInt(limitRaw, "limit", MAX_EVENT_PAGE_LIMIT);
    if (limitResult.error) {
      return res.status(400).json({
        error: "invalid_query",
        message: limitResult.error
      });
    }
    const limit = limitResult.value ?? DEFAULT_EVENT_PAGE_LIMIT;

    const agentId = parseOptionalAgentId(
      typeof req.query.agentId === "string" ? req.query.agentId : undefined
    );
    if (agentId && !isValidAgentId(agentId)) {
      return res.status(400).json({
        error: "invalid_query",
        message: "agentId must match ^[a-zA-Z0-9_-]{1,64}$"
      });
    }

    const result = await store.listPage({
      sinceId: sinceIdResult.value !== null ? String(sinceIdResult.value) : undefined,
      agentId: agentId ?? undefined,
      limit
    });

    res.json({
      data: result.events,
      page: {
        limit,
        hasMore: result.hasMore,
        nextSinceId: result.nextSinceId
      }
    });
  }));

  app.get("/v1/events/stream", wrapAsync(async (req, res) => {
    const sinceIdRaw = typeof req.query.sinceId === "string" ? req.query.sinceId : undefined;
    const sinceIdResult = parseNonNegativeInt(sinceIdRaw, "sinceId");
    if (sinceIdResult.error) {
      return res.status(400).json({
        error: "invalid_query",
        message: sinceIdResult.error
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    writeSseEvent(res, "hello", {
      serverTime: new Date().toISOString(),
      boardWidth: config.boardWidth,
      boardHeight: config.boardHeight
    });

    if (sinceIdResult.value !== null) {
      const catchup = await store.listPage({
        sinceId: String(sinceIdResult.value),
        limit: DEFAULT_STREAM_CATCHUP_LIMIT
      });
      if (catchup.events.length > 0) {
        writeSseEvent(res, "events", {
          events: catchup.events,
          count: catchup.events.length,
          hasMore: catchup.hasMore,
          nextSinceId: catchup.nextSinceId
        });
      }
    }

    const clientId = nextSseClientId;
    nextSseClientId += 1;
    sseClients.set(clientId, res);

    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(": keep-alive\n\n");
      }
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(clientId);
    });
  }));

  app.get("/v1/meta", wrapAsync(async (_req, res) => {
    const stats = await store.getEventStats();
    res.json({
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
  }));

  app.get("/v1/board", wrapAsync(async (_req, res) => {
    res.json({
      data: await store.buildBoardSnapshot(config.boardWidth, config.boardHeight)
    });
  }));

  app.get("/v1/board/region", wrapAsync(async (req, res) => {
    const xRaw = typeof req.query.x === "string" ? req.query.x : undefined;
    const yRaw = typeof req.query.y === "string" ? req.query.y : undefined;
    const wRaw = typeof req.query.w === "string" ? req.query.w : undefined;
    const hRaw = typeof req.query.h === "string" ? req.query.h : undefined;

    const xResult = parseBoundedCoordinate(xRaw, "x", config.boardWidth - 1);
    const yResult = parseBoundedCoordinate(yRaw, "y", config.boardHeight - 1);
    const wResult = parsePositiveInt(wRaw, "w");
    const hResult = parsePositiveInt(hRaw, "h");

    const errors = [xResult.error, yResult.error, wResult.error, hResult.error].filter(Boolean);
    if (errors.length > 0) {
      return res.status(400).json({
        error: "invalid_query",
        message: errors[0]
      });
    }

    if (
      xResult.value === null ||
      yResult.value === null ||
      wResult.value === null ||
      hResult.value === null
    ) {
      return res.status(400).json({
        error: "invalid_query",
        message: "x, y, w, h are required"
      });
    }

    const x = xResult.value;
    const y = yResult.value;
    const w = wResult.value;
    const h = hResult.value;

    if (x + w > config.boardWidth || y + h > config.boardHeight) {
      return res.status(400).json({
        error: "invalid_query",
        message: "region exceeds board bounds"
      });
    }

    if (w * h > MAX_REGION_AREA) {
      return res.status(400).json({
        error: "region_too_large",
        message: `region area must be <= ${MAX_REGION_AREA}`
      });
    }

    const data = await store.buildBoardRegionSnapshot(x, y, w, h);
    const stats = await store.getEventStats();
    return res.json({
      data: {
        ...data,
        latestEventId: stats.latestEventId
      }
    });
  }));

  app.post("/v1/board/cells/query", wrapAsync(async (req, res) => {
    const parsed = readCoordinateArray(req.body);
    if (parsed.error || !parsed.coordinates) {
      return res.status(400).json({
        error: "invalid_payload",
        message: parsed.error
      });
    }

    const outOfRange = parsed.coordinates.find(
      (coordinate) =>
        coordinate.x < 0 ||
        coordinate.x >= config.boardWidth ||
        coordinate.y < 0 ||
        coordinate.y >= config.boardHeight
    );
    if (outOfRange) {
      return res.status(400).json({
        error: "invalid_payload",
        message: "all coordinates must be inside board bounds"
      });
    }

    const results = await store.queryBoardCells(parsed.coordinates);
    const found = results.reduce((count, item) => count + (item.cell ? 1 : 0), 0);
    const stats = await store.getEventStats();

    return res.json({
      data: {
        requested: parsed.coordinates.length,
        found,
        latestEventId: stats.latestEventId,
        results
      }
    });
  }));

  app.post("/v1/pixel-events", wrapAsync(async (req, res) => {
    const result = await createPixelEvent(
      {
        authorizationHeader: req.header("authorization"),
        agentIdHeader: req.header("x-openclaw-agent-id"),
        knownLatestIdHeader: req.header("x-openclaw-known-latest-id"),
        payload: req.body
      },
      config,
      store
    );
    setServiceHeaders(res, result.headers);

    if (result.status === 201) {
      broadcastEvents(extractCreatedEvents(result.body));
    }

    return res.status(result.status).json(result.body);
  }));

  app.post("/api/v1/agents/register", wrapAsync(async (req, res) => {
    const result = await registerAgent(req.body ?? {}, store);
    if (result.status !== 201) {
      return res.status(result.status).json(result.body);
    }

    const host = req.get("host");
    const protocol = req.protocol;
    const origin = host ? `${protocol}://${host}` : "";

    return res.status(201).json({
      ...result.body,
      instructions: {
        skillUrl: origin ? `${origin}/skill.md` : "/skill.md",
        heartbeatUrl: origin ? `${origin}/heartbeat.md` : "/heartbeat.md",
        postUrl: origin ? `${origin}/v1/pixel-events` : "/v1/pixel-events"
      }
    });
  }));

  app.get("/api/v1/agents", wrapAsync(async (_req, res) => {
    res.json({
      data: await store.listAgents()
    });
  }));

  const publicDir = path.resolve(__dirname, "..", "public");
  app.use("/", express.static(publicDir));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Avoid leaking stack traces in API responses.
    if (err instanceof Error) {
      return res.status(500).json({
        error: "internal_error",
        message: err.message
      });
    }
    return res.status(500).json({
      error: "internal_error",
      message: "unknown error"
    });
  });

  return app;
}
