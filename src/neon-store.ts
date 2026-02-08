import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  AgentRecord,
  BoardCell,
  BoardRegionSnapshot,
  BoardSnapshot,
  CellCoordinate,
  CellQueryResult,
  EventListOptions,
  EventListResult,
  PixelEvent,
  PixelPlacementInput,
  StoreEventStats
} from "./types";
import { PixelStore } from "./store";

interface EventRow {
  id: string | number;
  x: number;
  y: number;
  glyph: string;
  color: string;
  agent_id: string;
  created_at: Date | string;
}

interface CellRow {
  x: number;
  y: number;
  glyph: string;
  color: string;
  agent_id: string;
  updated_at: Date | string;
  event_id: string | number;
}

interface AgentRow {
  agent_id: string;
  name: string;
  description: string | null;
  api_key: string;
  created_at: Date | string;
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}

function toEvent(row: EventRow): PixelEvent {
  return {
    id: String(row.id),
    x: row.x,
    y: row.y,
    glyph: row.glyph,
    color: row.color,
    agentId: row.agent_id,
    createdAt: toIsoString(row.created_at)
  };
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    name: row.name,
    description: row.description ?? undefined,
    apiKey: row.api_key,
    createdAt: toIsoString(row.created_at)
  };
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (normalized.length > 0) {
    return normalized;
  }
  return `agent-${randomBytes(2).toString("hex")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export class NeonPixelStore implements PixelStore {
  private readonly pool: Pool;
  private initializePromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.initializePromise = this.ensureSchema();
    return this.initializePromise;
  }

  async addMany(payloads: PixelPlacementInput[], agentId: string): Promise<PixelEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created: PixelEvent[] = [];

      for (const payload of payloads) {
        const eventResult = await client.query<EventRow>(
          `INSERT INTO pixel_events (x, y, glyph, color, agent_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, x, y, glyph, color, agent_id, created_at`,
          [payload.x, payload.y, payload.glyph, payload.color, agentId]
        );
        const eventRow = eventResult.rows[0];
        const createdEvent = toEvent(eventRow);
        created.push(createdEvent);

        await client.query(
          `INSERT INTO board_cells (x, y, glyph, color, agent_id, updated_at, event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (x, y)
           DO UPDATE SET
             glyph = EXCLUDED.glyph,
             color = EXCLUDED.color,
             agent_id = EXCLUDED.agent_id,
             updated_at = EXCLUDED.updated_at,
             event_id = EXCLUDED.event_id`,
          [
            payload.x,
            payload.y,
            payload.glyph,
            payload.color,
            agentId,
            eventRow.created_at,
            eventRow.id
          ]
        );
      }

      await client.query("COMMIT");
      return created;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(sinceId?: string): Promise<PixelEvent[]> {
    if (sinceId && /^[0-9]+$/.test(sinceId)) {
      const result = await this.pool.query<EventRow>(
        `SELECT id, x, y, glyph, color, agent_id, created_at
         FROM pixel_events
         WHERE id > $1::bigint
         ORDER BY id ASC`,
        [sinceId]
      );
      return result.rows.map(toEvent);
    }

    const result = await this.pool.query<EventRow>(
      `SELECT id, x, y, glyph, color, agent_id, created_at
       FROM pixel_events
       ORDER BY id ASC`
    );
    return result.rows.map(toEvent);
  }

  async listPage(options: EventListOptions): Promise<EventListResult> {
    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.sinceId && /^[0-9]+$/.test(options.sinceId)) {
      params.push(options.sinceId);
      whereClauses.push(`id > $${params.length}::bigint`);
    }

    if (options.agentId) {
      params.push(options.agentId);
      whereClauses.push(`agent_id = $${params.length}`);
    }

    params.push(options.limit + 1);

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const result = await this.pool.query<EventRow>(
      `SELECT id, x, y, glyph, color, agent_id, created_at
       FROM pixel_events
       ${whereSql}
       ORDER BY id ASC
       LIMIT $${params.length}::int`,
      params
    );

    const hasMore = result.rows.length > options.limit;
    const selectedRows = hasMore ? result.rows.slice(0, options.limit) : result.rows;
    const events = selectedRows.map(toEvent);

    return {
      events,
      hasMore,
      nextSinceId:
        events.length > 0
          ? events[events.length - 1].id
          : options.sinceId ?? null
    };
  }

  async buildBoardSnapshot(width: number, height: number): Promise<BoardSnapshot> {
    const region = await this.buildBoardRegionSnapshot(0, 0, width, height);
    return {
      width,
      height,
      cells: region.cells,
      totalEvents: region.totalEvents
    };
  }

  async buildBoardRegionSnapshot(
    originX: number,
    originY: number,
    width: number,
    height: number
  ): Promise<BoardRegionSnapshot> {
    const [cellsResult, totalResult] = await Promise.all([
      this.pool.query<CellRow>(
        `SELECT x, y, glyph, color, agent_id, updated_at, event_id
         FROM board_cells
         WHERE x >= $1 AND x < $2 AND y >= $3 AND y < $4
         ORDER BY event_id ASC`,
        [originX, originX + width, originY, originY + height]
      ),
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pixel_events`)
    ]);

    const cells: BoardCell[] = cellsResult.rows.map((row) => ({
      x: row.x,
      y: row.y,
      glyph: row.glyph,
      color: row.color,
      agentId: row.agent_id,
      updatedAt: toIsoString(row.updated_at),
      eventId: String(row.event_id)
    }));

    return {
      x: originX,
      y: originY,
      width,
      height,
      cells,
      totalEvents: Number(totalResult.rows[0]?.count ?? "0")
    };
  }

  async queryBoardCells(coordinates: CellCoordinate[]): Promise<CellQueryResult[]> {
    if (coordinates.length === 0) {
      return [];
    }

    const xList = coordinates.map((coordinate) => coordinate.x);
    const yList = coordinates.map((coordinate) => coordinate.y);

    const result = await this.pool.query<CellRow>(
      `SELECT bc.x, bc.y, bc.glyph, bc.color, bc.agent_id, bc.updated_at, bc.event_id
       FROM board_cells bc
       JOIN (
         SELECT DISTINCT x, y
         FROM UNNEST($1::int[], $2::int[]) AS req(x, y)
       ) requested ON requested.x = bc.x AND requested.y = bc.y`,
      [xList, yList]
    );

    const byCoordinate = new Map<string, BoardCell>();
    for (const row of result.rows) {
      byCoordinate.set(`${row.x}:${row.y}`, {
        x: row.x,
        y: row.y,
        glyph: row.glyph,
        color: row.color,
        agentId: row.agent_id,
        updatedAt: toIsoString(row.updated_at),
        eventId: String(row.event_id)
      });
    }

    return coordinates.map((coordinate) => ({
      x: coordinate.x,
      y: coordinate.y,
      cell: byCoordinate.get(`${coordinate.x}:${coordinate.y}`) ?? null
    }));
  }

  async getEventStats(): Promise<StoreEventStats> {
    const result = await this.pool.query<{ total_events: string; latest_event_id: string | null }>(
      `SELECT
         COUNT(*)::text AS total_events,
         MAX(id)::text AS latest_event_id
       FROM pixel_events`
    );
    const row = result.rows[0];
    return {
      totalEvents: Number(row?.total_events ?? "0"),
      latestEventId: row?.latest_event_id ?? null
    };
  }

  async getLatestEventAtByAgent(agentId: string): Promise<string | null> {
    const result = await this.pool.query<{ created_at: Date | string }>(
      `SELECT created_at
       FROM pixel_events
       WHERE agent_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    return row ? toIsoString(row.created_at) : null;
  }

  async registerAgent(name: string, description?: string): Promise<AgentRecord> {
    const baseId = slugify(name);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidateId =
        attempt === 0 ? baseId : `${baseId}-${randomBytes(2).toString("hex")}`;
      const apiKey = `apb_${randomBytes(24).toString("base64url")}`;
      try {
        const result = await this.pool.query<AgentRow>(
          `INSERT INTO agents (agent_id, name, description, api_key)
           VALUES ($1, $2, $3, $4)
           RETURNING agent_id, name, description, api_key, created_at`,
          [candidateId, name, description ?? null, apiKey]
        );
        return toAgent(result.rows[0]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("failed to generate unique agent id");
  }

  async findAgentByApiKey(apiKey: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query<AgentRow>(
      `SELECT agent_id, name, description, api_key, created_at
       FROM agents
       WHERE api_key = $1
       LIMIT 1`,
      [apiKey]
    );
    return result.rows[0] ? toAgent(result.rows[0]) : undefined;
  }

  async findAgentById(agentId: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query<AgentRow>(
      `SELECT agent_id, name, description, api_key, created_at
       FROM agents
       WHERE agent_id = $1
       LIMIT 1`,
      [agentId]
    );
    return result.rows[0] ? toAgent(result.rows[0]) : undefined;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query<AgentRow>(
      `SELECT agent_id, name, description, api_key, created_at
       FROM agents
       ORDER BY created_at ASC`
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      name: row.name,
      description: row.description ?? undefined,
      apiKey: "[REDACTED]",
      createdAt: toIsoString(row.created_at)
    }));
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.createTables(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async createTables(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        api_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pixel_events (
        id BIGSERIAL PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        glyph TEXT NOT NULL,
        color TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS board_cells (
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        glyph TEXT NOT NULL,
        color TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_id BIGINT NOT NULL REFERENCES pixel_events(id),
        PRIMARY KEY (x, y)
      );
    `);

    await client.query(`
      ALTER TABLE pixel_events
      DROP CONSTRAINT IF EXISTS pixel_events_agent_id_fkey;
    `);

    await client.query(`
      ALTER TABLE board_cells
      DROP CONSTRAINT IF EXISTS board_cells_agent_id_fkey;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pixel_events_id ON pixel_events(id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pixel_events_agent_id ON pixel_events(agent_id, id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_board_cells_event_id ON board_cells(event_id);
    `);
  }
}
