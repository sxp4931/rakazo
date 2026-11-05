import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createHostControlHandler } from "./host-control.mjs";

describe("fixed host control actions", () => {
  it("requires the dedicated token and accepts only fixed action routes", async () => {
    expect(() => createHostControlHandler({ token: "" })).toThrow(/required/i);
    const run = vi.fn(async () => true);
    const handler = createHostControlHandler({ token: "dedicated-token", run });

    expect((await request(handler, { method: "POST", url: "/restart" })).status).toBe(401);
    expect(
      (
        await request(handler, {
          method: "POST",
          url: "/anything",
          authorization: "Bearer dedicated-token",
        })
      ).status,
    ).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("schedules restarts after the requesting update process can return", async () => {
    const scheduled: Array<() => void> = [];
    const run = vi.fn(async (service: unknown) => service === "rakazo-source-updater.service");
    const handler = createHostControlHandler({
      token: "dedicated-token",
      run: async ([, args]) => run(args[1]),
      schedule: (work: () => void) => scheduled.push(work),
    });
    const response = await request(handler, {
      method: "POST",
      url: "/reload-updater",
      authorization: "Bearer dedicated-token",
    });
    expect(response.status).toBe(202);
    expect(run).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(run).toHaveBeenCalledWith("rakazo-source-updater.service");
  });
});

async function request(
  handler: ReturnType<typeof createHostControlHandler>,
  input: { method: string; url: string; authorization?: string },
) {
  let status = 0;
  const response = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end: vi.fn(),
  };
  const request = {
    ...input,
    headers: input.authorization ? { authorization: input.authorization } : {},
    resume: vi.fn(),
  };
  await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status, response };
}
