import type { Actor } from "@rakazo/contracts";
import { UsageRecordSchema, UsageSummarySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { contentRoutes } from "./content.js";
import type { RouterContext } from "./context.js";

const actor = { spaceId: "space-fixture", userId: "user-fixture" } as Actor;

function procedureTree(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "handler" ? (handler: unknown) => handler : procedureTree(),
    },
  );
}

function routes(usageRecord: unknown) {
  return contentRoutes({
    deps: { prisma: { usageRecord } },
    repos: {},
    groupRepos: {},
    favicons: {},
    authed: procedureTree(),
  } as unknown as RouterContext);
}

describe("usage routes", () => {
  it("returns allowance only for measured receipts and keeps it separate from cost", async () => {
    const aggregate = async () => ({
      _sum: {
        inputTokens: 1200,
        outputTokens: 34,
        totalTokens: 1234,
        costUsd: null,
        allowanceUsd: 0.00412,
      },
      _count: {
        _all: 3,
        inputTokens: 3,
        outputTokens: 3,
        totalTokens: 3,
        costUsd: 2,
        allowanceUsd: 1,
      },
    });
    const groupBy = async ({ by }: { by: string[] }) =>
      by.includes("provider")
        ? [
            {
              provider: "fixture",
              model: "model-a",
              _sum: {
                inputTokens: 1200,
                outputTokens: 34,
                totalTokens: 1234,
                costUsd: null,
                allowanceUsd: 0.00412,
              },
              _count: {
                _all: 3,
                inputTokens: 3,
                outputTokens: 3,
                totalTokens: 3,
                costUsd: 2,
                allowanceUsd: 1,
              },
            },
          ]
        : [{ runId: "run-fixture", parentRunId: "run-fixture" }];
    const usage = await (
      routes({ aggregate, groupBy }).usage.summary as unknown as (args: {
        context: { actor: Actor };
      }) => Promise<unknown>
    )({ context: { actor } });

    expect(UsageSummarySchema.parse(usage)).toMatchObject({
      costUsd: null,
      allowanceUsd: 0.00412,
      allowanceCalls: 1,
      modelCalls: 3,
      models: [
        {
          costUsd: null,
          allowanceUsd: 0.00412,
          allowanceCalls: 1,
          modelCalls: 3,
        },
      ],
    });
  });

  it("includes the nullable allowance receipt in per-call results", async () => {
    const findMany = async () => [
      {
        id: "usage-fixture",
        botId: null,
        runId: null,
        provider: "fixture",
        model: "model-a",
        inputTokens: 1200,
        outputTokens: 34,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        reasoningTokens: null,
        totalTokens: 1234,
        costUsd: 0,
        allowanceUsd: 0.00412,
        costSource: "provider-reported",
        pricingVersion: null,
        usageSource: "provider-reported-via-pi",
        callId: "call-fixture",
        operationId: null,
        operationKind: "answer",
        parentRunId: null,
        agentId: null,
        createdAt: new Date("2026-11-05T12:00:00.000Z"),
      },
    ];
    const usage = await (
      routes({ findMany }).usage.list as unknown as (args: {
        context: { actor: Actor };
      }) => Promise<unknown>
    )({ context: { actor } });

    expect(UsageRecordSchema.array().parse(usage)).toMatchObject([
      { costUsd: 0, allowanceUsd: 0.00412 },
    ]);
  });
});
