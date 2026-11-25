import type { AdapterContext, NotificationMessage } from "@rakazo/adapter-kit";
import { sendRoutineDelayAlert, shouldAlertDelayedRoutine } from "@rakazo/adapters";
import { ROUTINE_DELAY_GRACE_MS } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { LeaseHeldError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export { sendRoutineDelayAlert, shouldAlertDelayedRoutine } from "@rakazo/adapters";

type Deliver = (
  message: NotificationMessage,
  context: AdapterContext,
) => Promise<"delivered" | "undeliverable">;

/** Worker-local detection cannot report a complete worker outage. */
export function startRoutineDelayAlerts(
  prisma: PrismaClient,
  deliver: Deliver,
  events?: Pick<ThreadEvents, "publishSpaceChange">,
): () => Promise<void> {
  let stopping = false;
  let scanning = false;
  let scanWork: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const scan = async () => {
    if (stopping || scanning) return;
    scanning = true;
    try {
      let cursor: string | undefined;
      const now = new Date();
      await clearRecoveredRoutineDelayAlerts(prisma, now, events);
      do {
        const rows = await prisma.routine.findMany({
          where: {
            active: true,
            delayAlertsEnabled: true,
            nextRunAt: { lt: new Date(now.getTime() - ROUTINE_DELAY_GRACE_MS) },
            bot: { archivedAt: null },
          },
          orderBy: { id: "asc" },
          take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: { bot: { select: { thread: { select: { id: true } } } } },
        });
        for (const row of rows) {
          const threadId = row.threadId ?? row.bot.thread?.id;
          if (!threadId || !shouldAlertDelayedRoutine(row, now)) continue;
          const work = sendRoutineDelayAlert(prisma, deliver, { ...row, threadId }, now)
            .then(() => events?.publishSpaceChange?.(row.spaceId, "routines"))
            .catch((error) => {
              if (!(error instanceof LeaseHeldError))
                getLogger().error("routine delay scan", error);
            });
          pending.add(work);
          void work.finally(() => pending.delete(work));
        }
        cursor = rows.length === 100 ? rows.at(-1)?.id : undefined;
      } while (cursor && !stopping);
    } finally {
      scanning = false;
    }
  };
  const tick = () => {
    if (scanWork) return;
    scanWork = scan()
      .catch((error) => getLogger().error("routine delay scan", error))
      .finally(() => {
        scanWork = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  return async () => {
    stopping = true;
    clearInterval(timer);
    await scanWork;
    await Promise.allSettled([...pending]);
  };
}

export async function clearRecoveredRoutineDelayAlerts(
  prisma: PrismaClient,
  now: Date,
  events?: Pick<ThreadEvents, "publishSpaceChange">,
): Promise<void> {
  const where = {
    delayAlertSchedule: { not: null },
    OR: [
      { active: false },
      { delayAlertsEnabled: false },
      { nextRunAt: null },
      { nextRunAt: { gte: new Date(now.getTime() - ROUTINE_DELAY_GRACE_MS) } },
    ],
  };
  const spaces = events?.publishSpaceChange
    ? await prisma.routine.findMany({ where, select: { spaceId: true } })
    : [];
  const updated = await prisma.routine.updateMany({
    where,
    data: { delayAlertSchedule: null, delayAlertResult: null },
  });
  if (updated.count > 0) {
    for (const spaceId of new Set(spaces.map((row) => row.spaceId)))
      await events?.publishSpaceChange?.(spaceId, "routines");
  }
}
