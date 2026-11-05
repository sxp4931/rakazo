import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const ACTIONS = new Map([
  ["/backup", ["/usr/local/sbin/rakazo-backup-laptop", []]],
  [
    "/restart",
    [
      "/usr/bin/systemctl",
      ["restart", "rakazo-api.service", "rakazo-worker.service", "rakazo-web.service"],
    ],
  ],
  ["/reload-updater", ["/usr/bin/systemctl", ["restart", "rakazo-source-updater.service"]]],
]);

function authorized(header, token) {
  const supplied = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7) : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function runFixedCommand(action) {
  const [program, args] = action;
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { timeout: 15 * 60_000, maxBuffer: 64 * 1024, shell: false },
      (error) => {
        resolve(!error);
      },
    );
  });
}

export function createHostControlServer({ token, run = runFixedCommand, schedule = setTimeout }) {
  return createServer(createHostControlHandler({ token, run, schedule }));
}

export function createHostControlHandler({ token, run = runFixedCommand, schedule = setTimeout }) {
  if (!token) throw new Error("RAKAZO_HOST_CONTROL_TOKEN is required");
  return async (request, response) => {
    const action = ACTIONS.get(request.url ?? "");
    request.resume();
    if (request.method !== "POST" || !action) {
      response.writeHead(404).end();
      return;
    }
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/restart" || request.url === "/reload-updater") {
      response.writeHead(202).end();
      schedule(() => {
        void run(action).then((ok) => {
          if (!ok) process.stderr.write(`Host action failed: ${request.url}\n`);
        });
      }, 500);
      return;
    }
    try {
      const ok = await run(action);
      response.writeHead(ok ? 204 : 503).end();
    } catch {
      response.writeHead(503).end();
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createHostControlServer({ token: process.env.RAKAZO_HOST_CONTROL_TOKEN });
  server.listen(7094, "127.0.0.1");
  const stop = () => server.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
