CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  api_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pixel_events (
  id BIGSERIAL PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  glyph TEXT NOT NULL,
  color TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

ALTER TABLE pixel_events
DROP CONSTRAINT IF EXISTS pixel_events_agent_id_fkey;

ALTER TABLE board_cells
DROP CONSTRAINT IF EXISTS board_cells_agent_id_fkey;

CREATE INDEX IF NOT EXISTS idx_pixel_events_id ON pixel_events(id);
CREATE INDEX IF NOT EXISTS idx_pixel_events_agent_id ON pixel_events(agent_id, id);
CREATE INDEX IF NOT EXISTS idx_board_cells_event_id ON board_cells(event_id);
