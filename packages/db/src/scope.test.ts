import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership, scoped } from "./scope.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  email: "ada@rakazo.test",
  isDeploymentOwner: false,
};

function fakePrisma(
  member: { userId: string; organizationId: string; user: { email: string } } | null,
  settings: { ownerUserId: string | null } | null,
): PrismaClient {
  return {
    member: { findFirst: async () => member },
    deploymentSettings: { findUnique: async () => settings },
  } as unknown as PrismaClient;
}

describe("scoped", () => {
  it("returns a record from the actor's workspace", () => {
    const record = { workspaceId: "ws-1", userId: "user-1", name: "bot" };
    expect(scoped(actor, record)).toBe(record);
  });

  it("returns a shared workspace record that has no owner user", () => {
    const record = { workspaceId: "ws-1" };
    expect(scoped(actor, record)).toBe(record);
  });

  it("rejects null records", () => {
    expect(() => scoped(actor, null)).toThrow(IsolationError);
  });

  it("rejects records from another workspace", () => {
    expect(() => scoped(actor, { workspaceId: "ws-2", userId: "user-1" })).toThrow(IsolationError);
  });

  it("rejects another user's records inside the same workspace", () => {
    expect(() => scoped(actor, { workspaceId: "ws-1", userId: "user-2" })).toThrow(IsolationError);
  });
});

describe("requireMembership", () => {
  const member = { userId: "user-1", organizationId: "ws-1", user: { email: "ada@rakazo.test" } };

  it("resolves the actor's workspace and email", async () => {
    const resolved = await requireMembership(fakePrisma(member, null), "user-1");
    expect(resolved).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      email: "ada@rakazo.test",
      isDeploymentOwner: false,
    });
  });

  it("marks the deployment owner when settings point at the member", async () => {
    const resolved = await requireMembership(
      fakePrisma(member, { ownerUserId: "user-1" }),
      "user-1",
    );
    expect(resolved.isDeploymentOwner).toBe(true);
  });

  it("throws an isolation error for users without a workspace", async () => {
    await expect(requireMembership(fakePrisma(null, null), "user-1")).rejects.toThrow(
      IsolationError,
    );
  });
});
