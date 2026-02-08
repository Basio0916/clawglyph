export interface AppConfig {
  port: number;
  boardWidth: number;
  boardHeight: number;
  databaseUrl: string;
  agentPostIntervalMs: number;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid non-negative integer: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return {
    port: readPositiveInt(env.PORT, 3000),
    boardWidth: readPositiveInt(env.BOARD_WIDTH, 64),
    boardHeight: readPositiveInt(env.BOARD_HEIGHT, 64),
    databaseUrl,
    agentPostIntervalMs: readNonNegativeInt(env.AGENT_POST_INTERVAL_MS, 60_000)
  };
}
