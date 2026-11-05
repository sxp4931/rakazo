import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import type { RouterContext } from "./context.js";

export function sourceUpdatesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    sourceUpdates: {
      state: authed.sourceUpdates.state.handler(async ({ context }) => {
        await requireSourceUpdateOwner(deps, context.actor);
        return deps.sourceUpdates!.state();
      }),
      check: authed.sourceUpdates.check.handler(async ({ context }) => {
        await requireSourceUpdateOwner(deps, context.actor);
        return deps.sourceUpdates!.check(context.actor);
      }),
      apply: authed.sourceUpdates.apply.handler(async ({ context, input }) => {
        await requireSourceUpdateOwner(deps, context.actor);
        return deps.sourceUpdates!.apply(input);
      }),
    },
  };
}

export async function requireSourceUpdateOwner(
  deps: Pick<RouterContext["deps"], "env" | "sourceUpdates" | "prisma">,
  actor: Actor,
): Promise<void> {
  if (!deps.env.sourceUpdatesEnabled || !deps.sourceUpdates) throw new ORPCError("FORBIDDEN");
  const settings = await runAsSystem("check the source update owner", () =>
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
  );
  if (settings?.ownerUserId !== actor.userId) throw new ORPCError("FORBIDDEN");
}
