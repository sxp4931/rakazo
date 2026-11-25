import { execFile } from "node:child_process";
import os from "node:os";
import { pollUntil } from "@rakazo/core";
import type { CommandResult } from "./index.js";
import type { SourceUpdateCommandRunner } from "./source-updater.js";

export function safePnpmEnvironment(
  source: NodeJS.ProcessEnv,
  includeDatabase: boolean,
): Record<string, string> {
  const keys = [
    "PATH",
    "LANG",
    "LC_ALL",
    "NODE_ENV",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT",
    "PNPM_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "API_URL",
    "WEB_ORIGIN",
    "RAKAZO_HOST",
    "API_PORT",
    "WEB_PORT",
    "API_PROXY_TARGET",
  ];
  if (includeDatabase) keys.push("DATABASE_URL", "DATABASE_MIGRATION_URL");
  return {
    ...Object.fromEntries(keys.flatMap((key) => (source[key] ? [[key, source[key]!]] : []))),
    HOME: os.homedir(),
  };
}

export function createSourceUpdaterCommandRunner(
  source: NodeJS.ProcessEnv,
): SourceUpdateCommandRunner {
  return async (command, args, options) => {
    if (command === "git" || command === "pnpm") {
      const env = options.env ?? safeGitEnvironment(source);
      return execFileResult(command, args, { cwd: options.cwd, timeoutMs: options.timeoutMs, env });
    }
    const actions = {
      backup: "backup",
      restart: "restart",
      "reload-helper": "reload-updater",
    } as const;
    if (command === "health") return waitForApiHealth(options.timeoutMs);
    return hostControlRequest(source, actions[command], options.timeoutMs);
  };
}

async function hostControlRequest(
  source: NodeJS.ProcessEnv,
  action: "backup" | "restart" | "reload-updater",
  timeoutMs: number,
): Promise<CommandResult> {
  const token = source.RAKAZO_HOST_CONTROL_TOKEN;
  if (!token)
    return { ok: false, exitCode: null, stdout: "", output: "Host control is unavailable." };
  try {
    const response = await fetch(`http://127.0.0.1:7094/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { ok: true, exitCode: 0, stdout: "", output: "" }
      : {
          ok: false,
          exitCode: response.status,
          stdout: "",
          output: "Host control refused the action.",
        };
  } catch {
    return { ok: false, exitCode: null, stdout: "", output: "Host control could not be reached." };
  }
}

function safeGitEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return {
    ...Object.fromEntries(keys.flatMap((key) => (source[key] ? [[key, source[key]!]] : []))),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    CI: "1",
  };
}

async function waitForApiHealth(timeoutMs: number): Promise<CommandResult> {
  return pollUntil(
    async () => {
      try {
        const response = await fetch("http://127.0.0.1:3100/ready", {
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok ? { ok: true, exitCode: 0, stdout: "", output: "" } : undefined;
      } catch {
        return undefined;
      }
    },
    {
      intervalMs: 2_000,
      timeoutMs,
      onTimeout: () => ({
        ok: false,
        exitCode: null,
        stdout: "",
        output: "The API readiness check timed out.",
      }),
    },
  );
}

function execFileResult(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG, ...options.env },
      },
      (error, stdout, stderr) => {
        const outputStdout = String(stdout);
        const output = `${outputStdout}${stderr}`.trimEnd();
        resolve({
          ok: !error,
          exitCode: error && typeof error.code === "number" ? error.code : error ? null : 0,
          stdout: outputStdout,
          output: output.length > 8_000 ? output.slice(-8_000) : output,
        });
      },
    );
  });
}
