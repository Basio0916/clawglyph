import { AppConfig, loadConfig } from "./config";
import { NeonPixelStore } from "./neon-store";
import { PixelStore } from "./store";
import { PixelEvent } from "./types";

interface RuntimeContext {
  config: AppConfig;
  store: PixelStore;
}

type EventListener = (events: PixelEvent[]) => void;

let runtimePromise: Promise<RuntimeContext> | null = null;
const eventListeners = new Set<EventListener>();

async function createRuntime(): Promise<RuntimeContext> {
  const config = loadConfig();
  const store = new NeonPixelStore(config.databaseUrl);
  await store.initialize();
  return { config, store };
}

export async function getRuntime(): Promise<RuntimeContext> {
  if (!runtimePromise) {
    runtimePromise = createRuntime();
  }
  return runtimePromise;
}

export function subscribeEvents(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function broadcastEvents(events: PixelEvent[]): void {
  if (events.length === 0) {
    return;
  }

  for (const listener of eventListeners) {
    listener(events);
  }
}
