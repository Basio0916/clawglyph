import { AppConfig } from "./config";
import { PixelStore } from "./store";
import { CellCoordinate, PixelPlacementInput } from "./types";
import { validateAgentId, validatePixelPlacement } from "./validation";

export interface CreatePixelEventInput {
  authorizationHeader: string | undefined;
  agentIdHeader: string | undefined;
  knownLatestIdHeader: string | undefined;
  payload: unknown;
}

export interface ServiceResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface RegisterAgentInput {
  name: unknown;
  description?: unknown;
}

export const MAX_BATCH_SIZE = 100;

function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }
  if (!authorizationHeader.startsWith("Bearer ")) {
    return null;
  }
  return authorizationHeader.slice("Bearer ".length);
}

function parseKnownLatestId(knownLatestIdHeader: string | undefined): {
  value: number | null;
  error: string | null;
} {
  if (typeof knownLatestIdHeader === "undefined") {
    return { value: null, error: null };
  }

  const trimmed = knownLatestIdHeader.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      value: null,
      error: "x-openclaw-known-latest-id must be an integer >= 0"
    };
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return {
      value: null,
      error: "x-openclaw-known-latest-id must be an integer >= 0"
    };
  }

  return {
    value: parsed,
    error: null
  };
}

function dedupeCoordinates(items: PixelPlacementInput[]): CellCoordinate[] {
  const seen = new Set<string>();
  const unique: CellCoordinate[] = [];

  for (const item of items) {
    const key = `${item.x}:${item.y}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ x: item.x, y: item.y });
  }

  return unique;
}

export async function createPixelEvent(
  input: CreatePixelEventInput,
  config: AppConfig,
  store: PixelStore
): Promise<ServiceResponse> {
  const token = readBearerToken(input.authorizationHeader);
  if (!token) {
    return {
      status: 401,
      body: {
        error: "unauthorized",
        message: "valid bearer token is required"
      }
    };
  }

  let effectiveAgentId = "";
  const agent = await store.findAgentByApiKey(token);
  if (!agent) {
    return {
      status: 401,
      body: {
        error: "unauthorized",
        message: "unknown api key"
      }
    };
  }

  if (input.agentIdHeader) {
    const agentIdError = validateAgentId(input.agentIdHeader);
    if (agentIdError) {
      return {
        status: 400,
        body: {
          error: "invalid_agent",
          message: agentIdError
        }
      };
    }
    if (input.agentIdHeader !== agent.agentId) {
      return {
        status: 403,
        body: {
          error: "forbidden_agent",
          message: "header agent id does not match registered api key"
        }
      };
    }
  }
  effectiveAgentId = agent.agentId;

  const isBatch = Array.isArray(input.payload);
  const items: unknown[] = isBatch
    ? (input.payload as unknown[])
    : [input.payload];

  if (isBatch && items.length === 0) {
    return {
      status: 400,
      body: {
        error: "invalid_payload",
        message: "payload array must not be empty"
      }
    };
  }

  if (items.length > MAX_BATCH_SIZE) {
    return {
      status: 400,
      body: {
        error: "payload_too_large",
        message: `up to ${MAX_BATCH_SIZE} events are allowed per request`,
        maxBatchSize: MAX_BATCH_SIZE
      }
    };
  }

  const batchErrors: Array<{ index: number; errors: ReturnType<typeof validatePixelPlacement> }> =
    [];

  for (let index = 0; index < items.length; index += 1) {
    const errors = validatePixelPlacement(items[index], config.boardWidth, config.boardHeight);
    if (errors.length > 0) {
      batchErrors.push({ index, errors });
    }
  }

  if (batchErrors.length > 0) {
    return {
      status: 400,
      body: {
        error: "invalid_payload",
        details: isBatch ? batchErrors : batchErrors[0].errors
      }
    };
  }

  const precondition = parseKnownLatestId(input.knownLatestIdHeader);
  if (precondition.error) {
    return {
      status: 400,
      body: {
        error: "invalid_precondition",
        message: precondition.error
      }
    };
  }

  if (precondition.value !== null) {
    const coordinates = dedupeCoordinates(items as PixelPlacementInput[]);
    const currentCells = await store.queryBoardCells(coordinates);
    const conflicts = currentCells.filter((entry) => {
      if (!entry.cell) {
        return false;
      }
      const eventId = Number(entry.cell.eventId);
      return Number.isFinite(eventId) && eventId > precondition.value!;
    });

    if (conflicts.length > 0) {
      const stats = await store.getEventStats();
      return {
        status: 409,
        body: {
          error: "precondition_failed",
          message: "one or more target cells changed after the known latest event id",
          knownLatestId: String(precondition.value),
          latestEventId: stats.latestEventId,
          conflicts: conflicts.map((entry) => ({
            x: entry.x,
            y: entry.y,
            eventId: entry.cell?.eventId ?? null,
            agentId: entry.cell?.agentId ?? null
          }))
        }
      };
    }
  }

  if (config.agentPostIntervalMs > 0) {
    const lastPostedAt = await store.getLatestEventAtByAgent(effectiveAgentId);
    if (lastPostedAt) {
      const elapsedMs = Date.now() - new Date(lastPostedAt).getTime();
      if (elapsedMs < config.agentPostIntervalMs) {
        const retryAfterMs = Math.max(1, config.agentPostIntervalMs - elapsedMs);
        const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
        const nextAllowedAt = new Date(Date.now() + retryAfterMs).toISOString();
        return {
          status: 429,
          headers: {
            "retry-after": String(retryAfterSeconds)
          },
          body: {
            error: "rate_limited",
            message: `agent can post once every ${config.agentPostIntervalMs}ms`,
            retryAfterMs,
            retryAfterSeconds,
            nextAllowedAt
          }
        };
      }
    }
  }

  const created = await store.addMany(items as PixelPlacementInput[], effectiveAgentId);

  return {
    status: 201,
    body: {
      data: isBatch ? created : created[0],
      count: created.length
    }
  };
}

export async function registerAgent(
  input: RegisterAgentInput,
  store: PixelStore
): Promise<ServiceResponse> {
  if (typeof input.name !== "string") {
    return {
      status: 400,
      body: {
        error: "invalid_name",
        message: "name is required"
      }
    };
  }
  const trimmedName = input.name.trim();
  if (trimmedName.length < 2 || trimmedName.length > 64) {
    return {
      status: 400,
      body: {
        error: "invalid_name",
        message: "name length must be 2 to 64"
      }
    };
  }

  let description: string | undefined;
  if (typeof input.description !== "undefined") {
    if (typeof input.description !== "string") {
      return {
        status: 400,
        body: {
          error: "invalid_description",
          message: "description must be a string"
        }
      };
    }
    description = input.description.trim().slice(0, 280);
  }

  const created = await store.registerAgent(trimmedName, description);
  return {
    status: 201,
    body: {
      data: created
    }
  };
}
