import { ph, t } from "@lingui/core/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { runStatusLabel } from "@rakazo/i18n/activity";

export function routineHealthLines(health: RpcOutput<"routines/health">, locale: string): string[] {
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return [
    health.nextRunAt
      ? t`Next scheduled: ${ph({ date: date(health.nextRunAt) })}`
      : t`No upcoming schedule`,
    ...(health.delayed ? [t`Schedule delayed`] : []),
    ...(health.lastAttempt
      ? [
          t`Last attempt: ${ph({ date: date(health.lastAttempt.at) })} (${ph({ status: runStatusLabel(health.lastAttempt.status) })})`,
        ]
      : []),
    health.lastSuccessAt
      ? t`Last successful run: ${ph({ date: date(health.lastSuccessAt) })}`
      : t`No successful runs yet`,
  ];
}
