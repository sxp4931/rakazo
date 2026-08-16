import { pino, type Logger } from "pino";

export type { Logger };

const loggers = new Map<string, Logger>();

/**
 * Returns a shared pino logger for the named service.
 *
 * Level resolution: `LOG_LEVEL` wins; otherwise logs are silenced under
 * `NODE_ENV=test` so test runs stay readable, and `info` everywhere else.
 */
export function createLogger(name: string): Logger {
  const cached = loggers.get(name);
  if (cached) return cached;
  const logger = pino({ name, level: resolveLogLevel() });
  loggers.set(name, logger);
  return logger;
}

function resolveLogLevel(): string {
  const configured = process.env.LOG_LEVEL;
  if (configured) return configured;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}
