import type { AdapterContext, NotificationMessage } from "@rakazo/adapter-kit";
import { routineScheduleDelay } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type DelayState = {
  active: boolean;
  delayAlertsEnabled: boolean;
  nextRunAt: Date | null;
  delayAlertSchedule: Date | null;
  delayAlertCooldownAt: Date | null;
  delayAlertResult: string | null;
};

const HOUR = 60 * 60_000;
const LEASE_TTL_MS = 2 * 60_000;

/** A future nextRunAt includes intentional provider backoff and is never overdue. */
export function shouldAlertDelayedRoutine(row: DelayState, now: Date): boolean {
  const time = now.getTime();
  if (
    !row.delayAlertsEnabled ||
    !row.nextRunAt ||
    !routineScheduleDelay(row.active, row.nextRunAt, now)
  )
    return false;
  if (row.delayAlertSchedule && row.delayAlertResult === "sent") return false;
  if (row.delayAlertCooldownAt && time - row.delayAlertCooldownAt.getTime() < HOUR) return false;
  return true;
}

type AlertRow = Pick<
  DelayState,
  "nextRunAt" | "delayAlertSchedule" | "delayAlertCooldownAt" | "delayAlertResult"
> & {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  name: string;
};
type AlertPayload = { routineId: string; scheduledFor: string };
type Deliver = (
  message: NotificationMessage,
  context: AdapterContext,
) => Promise<"delivered" | "undeliverable">;

export async function sendRoutineDelayAlert(
  prisma: PrismaClient,
  deliver: Deliver,
  row: AlertRow,
  now: Date,
): Promise<void> {
  if (!row.nextRunAt) return;
  await withLease(
    prisma,
    `routine-delay-alert:${row.id}`,
    { ttlMs: LEASE_TTL_MS },
    async (lease) => {
      const claimed = await prisma.routine.updateMany({
        where: {
          id: row.id,
          spaceId: row.spaceId,
          userId: row.userId,
          active: true,
          bot: { archivedAt: null },
          delayAlertsEnabled: true,
          nextRunAt: row.nextRunAt,
          delayAlertSchedule: row.delayAlertSchedule,
          delayAlertCooldownAt: row.delayAlertCooldownAt,
          delayAlertResult: row.delayAlertResult,
        },
        data: { delayAlertSchedule: row.nextRunAt, delayAlertResult: "pending" },
      });
      if (!claimed.count) return;
      const current = await prisma.routine.findFirst({
        where: {
          id: row.id,
          spaceId: row.spaceId,
          userId: row.userId,
          active: true,
          bot: { archivedAt: null },
          delayAlertsEnabled: true,
          nextRunAt: row.nextRunAt,
          delayAlertSchedule: row.nextRunAt,
          delayAlertResult: "pending",
        },
        select: { id: true },
      });
      if (!current) return;
      let result: "sent" | "failed" = "failed";
      try {
        const sent = await deliver(
          {
            kind: "failure",
            title: "Schedule delayed",
            body: row.name,
            botId: row.botId,
            threadId: row.threadId,
            routineId: row.id,
          },
          {
            operationId: "routine-delay-alert",
            traceId: row.id,
            spaceId: row.spaceId,
            userId: row.userId,
            botId: row.botId,
            signal: lease.signal,
          },
        );
        if (sent === "delivered") result = "sent";
      } catch (error) {
        getLogger().error("routine delay alert", error);
      }
      await prisma.routine.updateMany({
        where: {
          id: row.id,
          active: true,
          delayAlertsEnabled: true,
          nextRunAt: row.nextRunAt,
          delayAlertSchedule: row.nextRunAt,
          delayAlertResult: "pending",
        },
        data: { delayAlertResult: result, delayAlertCooldownAt: now },
      });
    },
  );
}

/** Run when the scheduled wakeup plus grace period expires. Stale jobs are harmless. */
export async function handleRoutineDelayAlert(
  prisma: PrismaClient,
  deliver: Deliver,
  payload: AlertPayload,
): Promise<void> {
  const scheduledFor = new Date(payload.scheduledFor);
  const row = await prisma.routine.findFirst({
    where: {
      id: payload.routineId,
      active: true,
      delayAlertsEnabled: true,
      nextRunAt: scheduledFor,
      bot: { archivedAt: null },
    },
    include: { bot: { select: { thread: { select: { id: true } } } } },
  });
  const threadId = row?.threadId ?? row?.bot.thread?.id;
  if (!row || !threadId) return;
  const now = new Date();
  if (!shouldAlertDelayedRoutine(row, now)) return;
  await sendRoutineDelayAlert(prisma, deliver, { ...row, threadId }, now);
}
