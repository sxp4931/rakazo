import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { hasValidBearerToken, resolveUpdaterToken } from "@rakazo/core";
import { Hono } from "hono";
import { createSourceUpdater, createSourceUpdaterCommandRunner } from "./source-updater.js";

const SOURCE_UPDATER_HOST = "127.0.0.1";
const SOURCE_UPDATER_PORT = 7093;

export interface SourceUpdaterServiceConfig {
  deployDir: string;
  statePath: string;
  backupDir: string;
  token: string;
}

export function resolveSourceUpdaterServiceConfig(
  env: NodeJS.ProcessEnv,
): SourceUpdaterServiceConfig {
  const deployDir = env.RAKAZO_DEPLOY_DIR?.trim() ?? "";
  if (!deployDir.startsWith("/")) {
    throw new Error("RAKAZO_DEPLOY_DIR must be an absolute checkout path.");
  }
  return {
    deployDir,
    statePath:
      env.RAKAZO_SOURCE_UPDATER_STATE ?? path.join(deployDir, ".state", "source-update-state.json"),
    backupDir: env.RAKAZO_SOURCE_UPDATER_BACKUP_DIR ?? "/var/lib/rakazo/source-update-backups",
    token: resolveUpdaterToken(env),
  };
}

export function createSourceUpdaterApp(
  config: SourceUpdaterServiceConfig,
  options: { updater?: ReturnType<typeof createSourceUpdater> } = {},
) {
  const updater =
    options.updater ??
    createSourceUpdater({
      deployDir: config.deployDir,
      statePath: config.statePath,
      backupDir: config.backupDir,
      run: createSourceUpdaterCommandRunner(process.env),
    });
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "source-updater" }));
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!hasValidBearerToken(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.get("/source/state", (c) => c.json(updater.state()));
  app.post("/source/check", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pinnedCommit =
      body && typeof body === "object" && "targetCommit" in body
        ? (body as { targetCommit?: unknown }).targetCommit
        : undefined;
    if (
      pinnedCommit !== undefined &&
      (typeof pinnedCommit !== "string" || !/^[0-9a-f]{40}$/i.test(pinnedCommit))
    ) {
      return c.json({ error: "The reviewed commit is invalid." }, 400);
    }
    return c.json(await updater.check(pinnedCommit));
  });
  app.post("/source/apply", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !("currentCommit" in body) ||
      !("targetCommit" in body) ||
      typeof body.currentCommit !== "string" ||
      typeof body.targetCommit !== "string" ||
      !/^[0-9a-f]{40}$/i.test(body.currentCommit) ||
      !/^[0-9a-f]{40}$/i.test(body.targetCommit)
    ) {
      return c.json({ error: "The reviewed source revision is invalid." }, 400);
    }
    try {
      return c.json(await updater.apply(body));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "The source update could not start." },
        409,
      );
    }
  });
  return { app, updater };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = resolveSourceUpdaterServiceConfig(process.env);
  const { app, updater } = createSourceUpdaterApp(config);
  await updater.loadState();
  const server = serve({
    fetch: app.fetch,
    hostname: SOURCE_UPDATER_HOST,
    port: SOURCE_UPDATER_PORT,
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
