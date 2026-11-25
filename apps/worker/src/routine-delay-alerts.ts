import { sendRoutineDelayAlert, shouldAlertDelayedRoutine } from "@rakazo/adapters";
import type { AdapterContext, NotificationMessage } from "@rakazo/adapter-kit";
import { ROUTINE_DELAY_GRACE_MS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
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
      await clearRecoveredRoutineDelayAlerts(prisma, now);
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
          const work = sendRoutineDelayAlert(prisma, deliver, { ...row, threadId }, now).catch(
            (error) => getLogger().error("routine delay scan", error),
          );
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
): Promise<void> {
  await prisma.routine.updateMany({
    where: {
      delayAlertSchedule: { not: null },
      OR: [
        { active: false },
        { delayAlertsEnabled: false },
        { nextRunAt: null },
        { nextRunAt: { gte: new Date(now.getTime() - ROUTINE_DELAY_GRACE_MS) } },
      ],
    },
    data: { delayAlertSchedule: null, delayAlertClaimedAt: null, delayAlertResult: null },
  });
}
