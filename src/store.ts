import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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

interface PersistedData {
  nextId: number;
  events: PixelEvent[];
  agents: AgentRecord[];
}

export interface PixelStore {
  initialize(): Promise<void>;
  addMany(payloads: PixelPlacementInput[], agentId: string): Promise<PixelEvent[]>;
  list(sinceId?: string): Promise<PixelEvent[]>;
  listPage(options: EventListOptions): Promise<EventListResult>;
  buildBoardSnapshot(width: number, height: number): Promise<BoardSnapshot>;
  buildBoardRegionSnapshot(
    originX: number,
    originY: number,
    width: number,
    height: number
  ): Promise<BoardRegionSnapshot>;
  queryBoardCells(coordinates: CellCoordinate[]): Promise<CellQueryResult[]>;
  getEventStats(): Promise<StoreEventStats>;
  getLatestEventAtByAgent(agentId: string): Promise<string | null>;
  registerAgent(name: string, description?: string): Promise<AgentRecord>;
  findAgentByApiKey(apiKey: string): Promise<AgentRecord | undefined>;
  findAgentById(agentId: string): Promise<AgentRecord | undefined>;
  listAgents(): Promise<AgentRecord[]>;
}

export interface InMemoryPixelStoreOptions {
  persistenceFilePath?: string;
}

export class InMemoryPixelStore implements PixelStore {
  private events: PixelEvent[] = [];
  private agents: AgentRecord[] = [];
  private agentById = new Map<string, AgentRecord>();
  private agentByApiKey = new Map<string, AgentRecord>();
  private nextId = 1;
  private readonly persistenceFilePath?: string;
  private initialized = false;

  constructor(options: InMemoryPixelStoreOptions = {}) {
    this.persistenceFilePath = options.persistenceFilePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.persistenceFilePath) {
      this.loadFromDisk();
    }
    this.initialized = true;
  }

  async addMany(payloads: PixelPlacementInput[], agentId: string): Promise<PixelEvent[]> {
    const created: PixelEvent[] = [];
    for (const payload of payloads) {
      const event: PixelEvent = {
        id: String(this.nextId++),
        x: payload.x,
        y: payload.y,
        glyph: payload.glyph,
        color: payload.color,
        agentId,
        createdAt: new Date().toISOString()
      };
      this.events.push(event);
      created.push(event);
    }
    this.persistToDisk();
    return created;
  }

  async registerAgent(name: string, description?: string): Promise<AgentRecord> {
    const baseId = this.slugify(name);
    let agentId = baseId;
    while (this.agentById.has(agentId)) {
      agentId = `${baseId}-${randomBytes(2).toString("hex")}`;
    }

    const agent: AgentRecord = {
      agentId,
      name,
      description,
      apiKey: `apb_${randomBytes(24).toString("base64url")}`,
      createdAt: new Date().toISOString()
    };

    this.agents.push(agent);
    this.agentById.set(agent.agentId, agent);
    this.agentByApiKey.set(agent.apiKey, agent);
    this.persistToDisk();
    return agent;
  }

  async findAgentByApiKey(apiKey: string): Promise<AgentRecord | undefined> {
    return this.agentByApiKey.get(apiKey);
  }

  async findAgentById(agentId: string): Promise<AgentRecord | undefined> {
    return this.agentById.get(agentId);
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.agents.map((agent) => ({
      ...agent,
      apiKey: "[REDACTED]"
    }));
  }

  async list(sinceId?: string): Promise<PixelEvent[]> {
    if (!sinceId) {
      return [...this.events];
    }
    const sinceNumeric = Number(sinceId);
    if (!Number.isFinite(sinceNumeric)) {
      return [...this.events];
    }
    return this.events.filter((event) => Number(event.id) > sinceNumeric);
  }

  async listPage(options: EventListOptions): Promise<EventListResult> {
    const filteredBySince = (() => {
      if (!options.sinceId) {
        return this.events;
      }
      const sinceNumeric = Number(options.sinceId);
      if (!Number.isFinite(sinceNumeric)) {
        return this.events;
      }
      return this.events.filter((event) => Number(event.id) > sinceNumeric);
    })();

    const filtered = options.agentId
      ? filteredBySince.filter((event) => event.agentId === options.agentId)
      : filteredBySince;

    const events = filtered.slice(0, options.limit);
    const hasMore = filtered.length > options.limit;
    const nextSinceId =
      events.length > 0
        ? events[events.length - 1].id
        : options.sinceId ?? null;

    return {
      events: [...events],
      hasMore,
      nextSinceId
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
    const latestByCell = new Map<string, BoardCell>();

    for (const event of this.events) {
      if (
        event.x < originX ||
        event.x >= originX + width ||
        event.y < originY ||
        event.y >= originY + height
      ) {
        continue;
      }
      const key = `${event.x}:${event.y}`;
      latestByCell.set(key, {
        x: event.x,
        y: event.y,
        glyph: event.glyph,
        color: event.color,
        agentId: event.agentId,
        updatedAt: event.createdAt,
        eventId: event.id
      });
    }

    return {
      x: originX,
      y: originY,
      width,
      height,
      cells: Array.from(latestByCell.values()),
      totalEvents: this.events.length
    };
  }

  async queryBoardCells(coordinates: CellCoordinate[]): Promise<CellQueryResult[]> {
    const latestByCell = new Map<string, BoardCell>();
    for (const event of this.events) {
      const key = `${event.x}:${event.y}`;
      latestByCell.set(key, {
        x: event.x,
        y: event.y,
        glyph: event.glyph,
        color: event.color,
        agentId: event.agentId,
        updatedAt: event.createdAt,
        eventId: event.id
      });
    }

    return coordinates.map((coordinate) => {
      const key = `${coordinate.x}:${coordinate.y}`;
      return {
        x: coordinate.x,
        y: coordinate.y,
        cell: latestByCell.get(key) ?? null
      };
    });
  }

  async getEventStats(): Promise<StoreEventStats> {
    return {
      totalEvents: this.events.length,
      latestEventId: this.events.length > 0 ? this.events[this.events.length - 1].id : null
    };
  }

  async getLatestEventAtByAgent(agentId: string): Promise<string | null> {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event.agentId === agentId) {
        return event.createdAt;
      }
    }
    return null;
  }

  private loadFromDisk(): void {
    if (!this.persistenceFilePath || !fs.existsSync(this.persistenceFilePath)) {
      return;
    }
    const raw = fs.readFileSync(this.persistenceFilePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedData>;
    if (!Array.isArray(parsed.events) || typeof parsed.nextId !== "number") {
      throw new Error(`invalid persistence file: ${this.persistenceFilePath}`);
    }
    this.events = parsed.events;
    this.nextId = parsed.nextId;

    this.agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    this.agentById.clear();
    this.agentByApiKey.clear();
    for (const agent of this.agents) {
      this.agentById.set(agent.agentId, agent);
      this.agentByApiKey.set(agent.apiKey, agent);
    }
  }

  private persistToDisk(): void {
    if (!this.persistenceFilePath) {
      return;
    }
    const directory = path.dirname(this.persistenceFilePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload: PersistedData = {
      nextId: this.nextId,
      events: this.events,
      agents: this.agents
    };
    fs.writeFileSync(this.persistenceFilePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private slugify(value: string): string {
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
}
