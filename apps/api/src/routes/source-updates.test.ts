import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { requireSourceUpdateOwner } from "./source-updates.js";

const actor: Actor = {
  userId: "member-1",
  spaceId: "space-1",
  email: "member@example.test",
  isDeploymentOwner: false,
};

describe("source update ownership", () => {
  it("denies the feature while disabled", async () => {
    const findUnique = vi.fn();
    await expect(
      requireSourceUpdateOwner(
        {
          env: { sourceUpdatesEnabled: false },
          sourceUpdates: {} as never,
          prisma: { deploymentSettings: { findUnique } } as never,
        } as unknown as Pick<RouterContext["deps"], "env" | "sourceUpdates" | "prisma">,
        actor,
      ),
    ).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("allows only the explicitly provisioned deployment owner", async () => {
    const findUnique = vi.fn().mockResolvedValue({ ownerUserId: "owner-1" });
    const deps = {
      env: { sourceUpdatesEnabled: true },
      sourceUpdates: {} as never,
      prisma: { deploymentSettings: { findUnique } } as never,
    } as unknown as Pick<RouterContext["deps"], "env" | "sourceUpdates" | "prisma">;

    await expect(requireSourceUpdateOwner(deps, actor)).rejects.toThrow();
    await expect(
      requireSourceUpdateOwner(deps, { ...actor, userId: "owner-1" }),
    ).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
  });
});
