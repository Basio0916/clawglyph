import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp({ config });

  const server = createServer(app);

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `ClawGlyph listening on http://localhost:${config.port} (${config.boardWidth}x${config.boardHeight})`
    );
  });
}

void bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start ClawGlyph:", error);
  process.exit(1);
});
