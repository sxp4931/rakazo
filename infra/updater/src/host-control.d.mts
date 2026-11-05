import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface HostControlOptions {
  token: string | undefined;
  run?: (action: [string, string[]]) => Promise<boolean>;
  schedule?: (work: () => void, delay: number) => unknown;
}

export function createHostControlServer(options: HostControlOptions): Server;
export function createHostControlHandler(
  options: HostControlOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
