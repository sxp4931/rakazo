import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import { serve } from "@hono/node-server";
import { createLogger } from "@rakazo/core";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const logger = createLogger("api");
const env = loadEnv();
const { app, stop } = await createApp(env);
const server = serve({ fetch: app.fetch, port: env.port }, () => {
  logger.info({ port: env.port, url: `http://127.0.0.1:${env.port}` }, "rakazo api listening");
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await stop();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
