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
  it.each(["available", "conflict"])("summarizes %s changes and records usage", async (status) => {
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
    const fetch = vi.fn(async (_input: RequestInfo | URL) => {
      const update = candidate();
      update.commits = Array.from({ length: 100 }, (_, index) => ({
        commit: index.toString(16).padStart(40, "0"),
        subject: `Add official feature ${index} ${"x".repeat(300)}`,
      }));
      update.changedFiles = Array.from(
        { length: 300 },
        (_, index) => `packages/official/path-${index}-${"x".repeat(300)}`,
      );
      update.diff = "upstream diff".repeat(10_000);
      return new Response(JSON.stringify({ ...update, status }));
    });
    const resolveModel = vi.fn(
      async () =>
        ({
          provider: "configured-provider",
          id: "configured-model",
          apiKey: "fake-configured-key",
        }) as never,
    );
    const gateway = createSourceUpdatesGateway({
      token: "dedicated-token",
      prisma,
      runtime,
      resolveModel,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const preview = await gateway.check(actor);
    expect(preview.status).toBe(status);
    expect(preview.summary).toBe("The update adds safer source recovery.");
    expect(preview.summaryAvailable).toBe(true);
    expect(received?.tools).toEqual([]);
    expect(received?.instructions).toContain("untrusted source data");
    expect(received?.prompt).toContain("Add official feature 0");
    expect(received?.prompt).not.toContain("Add official feature 30");
    expect(received?.prompt).not.toContain("upstream diff");
    expect(received?.prompt?.length).toBeLessThanOrEqual(8_000);
    expect(received?.model).toMatchObject({
      provider: "configured-provider",
      id: "configured-model",
      apiKey: "fake-configured-key",
      thinkingLevel: "off",
    });
    expect(recorded).toHaveBeenCalledOnce();
    expect(resolveModel).toHaveBeenCalledWith({ userId: actor.userId, spaceId: actor.spaceId });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7093/source/check");
  });

  it("summarizes from upstream commit subjects when there is no diff", async () => {
    const run = vi.fn((_request: AgentRunRequest) =>
      (async function* () {
        yield { type: "done" as const, text: "The update adds source recovery." };
      })(),
    );
    const runtime = {
      describe: () => ({
        capabilities: { scripted: false, streaming: true, tools: false, compaction: false },
      }),
      run,
      abort: vi.fn(async () => {}),
    } as unknown as AgentRuntime;
    const value = candidate();
    value.diff = "";
    const gateway = createSourceUpdatesGateway({
      token: "dedicated-token",
      prisma: {} as PrismaClient,
      runtime,
      resolveModel: vi.fn(
        async () => ({ provider: "configured-provider", id: "configured-model" }) as never,
      ),
      fetch: vi.fn(
        async (_input: RequestInfo | URL) => new Response(JSON.stringify(value)),
      ) as unknown as typeof globalThis.fetch,
    });

    const preview = await gateway.check(actor);

    expect(preview.summary).toBe("The update adds source recovery.");
    expect(run).toHaveBeenCalledOnce();
  });

  it("forwards the reviewed fork commit to apply", async () => {
    const forkCommit = "d".repeat(40);
    const runResult = {
      startedAt: "2026-11-09T12:00:00.000Z",
      finishedAt: "2026-11-09T12:00:01.000Z",
      ok: true,
      currentCommit: "a".repeat(40),
      targetCommit: "b".repeat(40),
      stage: "complete",
      error: null,
      recovery: null,
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/source/check")
        ? new Response(JSON.stringify({ ...candidate(), forkCommit }))
        : new Response(JSON.stringify(runResult)),
    );
    const gateway = createSourceUpdatesGateway({
      token: "dedicated-token",
      prisma: {} as PrismaClient,
      runtime: {
        describe: () => ({
          capabilities: { scripted: true, streaming: true, tools: false, compaction: false },
        }),
        run: vi.fn(),
        abort: vi.fn(async () => {}),
      } as unknown as AgentRuntime,
      resolveModel: vi.fn(async () => ({ provider: "scripted", id: "scripted" }) as never),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const preview = await gateway.check(actor);
    const result = await gateway.apply({
      currentCommit: "a".repeat(40),
      targetCommit: "b".repeat(40),
      forkCommit,
    });

    expect(preview.forkCommit).toBe(forkCommit);
    expect(result).toEqual(runResult);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      currentCommit: "a".repeat(40),
      targetCommit: "b".repeat(40),
      forkCommit,
    });
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
