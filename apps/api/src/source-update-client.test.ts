import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createSourceUpdatesGateway } from "./source-update-client.js";

const actor: Actor = {
  userId: "owner-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("source update summary", () => {
  it("uses the configured runtime and records its usage", async () => {
    const recorded = vi.fn();
    const prisma = {
      $transaction: (callback: (tx: unknown) => unknown) =>
        callback({ usageRecord: { createMany: recorded } }),
    } as unknown as PrismaClient;
    let received: AgentRunRequest | undefined;
    const runtime = {
      describe: () => ({
        capabilities: { scripted: false, streaming: true, tools: false, compaction: false },
      }),
      run: (request: AgentRunRequest) => {
        received = request;
        return (async function* () {
          const usage = {
            type: "usage" as const,
            provider: "configured-provider",
            model: "configured-model",
            inputTokens: 12,
            outputTokens: 8,
          } satisfies Extract<AgentRuntimeEvent, { type: "usage" }>;
          await request.onUsage?.(usage);
          yield { ...usage, accounted: true };
          yield { type: "done" as const, text: "The update adds safer source recovery." };
        })();
      },
      abort: vi.fn(async () => {}),
    } as unknown as AgentRuntime;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(candidate())),
    );
    const gateway = createSourceUpdatesGateway({
      token: "dedicated-token",
      prisma,
      runtime,
      resolveModel: vi.fn(
        async () => ({ provider: "configured-provider", id: "configured-model" }) as never,
      ),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const preview = await gateway.check(actor);
    expect(preview.summary).toBe("The update adds safer source recovery.");
    expect(preview.summaryAvailable).toBe(true);
    expect(received?.tools).toEqual([]);
    expect(received?.instructions).toContain("untrusted source data");
    expect(received?.prompt).toContain("upstream diff");
    expect(recorded).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7093/source/check");
  });

  it("returns an honest fallback when no provider is configured", async () => {
    const run = vi.fn();
    const runtime = {
      describe: () => ({
        capabilities: { scripted: true, streaming: true, tools: false, compaction: false },
      }),
      run,
      abort: vi.fn(async () => {}),
    } as unknown as AgentRuntime;
    const gateway = createSourceUpdatesGateway({
      token: "dedicated-token",
      prisma: {} as PrismaClient,
      runtime,
      resolveModel: vi.fn(async () => {
        throw new Error("No model configured");
      }),
      fetch: vi.fn(
        async (_input: RequestInfo | URL) => new Response(JSON.stringify(candidate())),
      ) as unknown as typeof globalThis.fetch,
    });

    const preview = await gateway.check(actor);
    expect(preview.status).toBe("available");
    expect(preview.summary).toBeNull();
    expect(preview.summaryAvailable).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

function candidate() {
  return {
    status: "available",
    reason: null,
    currentCommit: "a".repeat(40),
    targetCommit: "b".repeat(40),
    branch: "main",
    changedPaths: [],
    conflictingPaths: [],
    commits: [{ commit: "b".repeat(40), subject: "Add source recovery" }],
    commitCount: 1,
    changedFiles: ["infra/updater/src/source-updater.ts"],
    fileCount: 1,
    diff: "upstream diff",
    mergeCommit: "c".repeat(40),
  };
}
