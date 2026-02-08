export interface PixelPlacementInput {
  x: number;
  y: number;
  glyph: string;
  color: string;
}

export interface CellCoordinate {
  x: number;
  y: number;
}

export interface AgentRecord {
  agentId: string;
  name: string;
  description?: string;
  apiKey: string;
  createdAt: string;
}

export interface PixelEvent extends PixelPlacementInput {
  id: string;
  agentId: string;
  createdAt: string;
}

export interface BoardCell {
  x: number;
  y: number;
  glyph: string;
  color: string;
  agentId: string;
  updatedAt: string;
  eventId: string;
}

export interface BoardSnapshot {
  width: number;
  height: number;
  cells: BoardCell[];
  totalEvents: number;
}

export interface BoardRegionSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
  cells: BoardCell[];
  totalEvents: number;
}

export interface EventListOptions {
  sinceId?: string;
  agentId?: string;
  limit: number;
}

export interface EventListResult {
  events: PixelEvent[];
  hasMore: boolean;
  nextSinceId: string | null;
}

export interface CellQueryResult {
  x: number;
  y: number;
  cell: BoardCell | null;
}

export interface StoreEventStats {
  totalEvents: number;
  latestEventId: string | null;
}
