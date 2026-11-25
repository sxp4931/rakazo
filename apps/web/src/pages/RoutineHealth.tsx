import { Trans, useLingui } from "@lingui/react/macro";
import { runStatusLabel } from "@rakazo/i18n/activity";
import { Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useSave, useSpaceQueries } from "../lib/query/query";

export function RoutineHealth({ routineId }: { routineId: string }) {
  const { i18n, t } = useLingui();
  const queries = useSpaceQueries();
  const fieldId = useId();
  const healthRead = queries.routines.health.queryOptions({ input: { routineId } });
  const health = useQuery({
    ...healthRead,
    refetchOnWindowFocus: "always",
  });
  const alerts = useSave({
    save: (input: { field: "delayed" | "failure"; enabled: boolean }, rpc) =>
      rpc.routines.setAlerts({ routineId, [input.field]: input.enabled }),
    stale: [healthRead.queryKey],
  });
  if (health.isError)
    return (
      <p role="alert">
        <Trans>Could not load schedule status</Trans>
      </p>
    );
  if (!health.data) return null;
  const date = (value: string) => new Date(value).toLocaleString(i18n.locale || "en");
  const { nextRunAt, delayed, lastAttempt, lastSuccessAt } = health.data;
  const setAlert = (field: "delayed" | "failure", enabled: boolean) =>
    alerts.run({ field, enabled });
  return (
    <section className="mt-6 space-y-1 text-sm text-muted-foreground" data-testid="routine-health">
      {nextRunAt ? (
        <p>
          <Trans>Next scheduled</Trans>: {date(nextRunAt)}
        </p>
      ) : (
        <p>
          <Trans>No upcoming schedule</Trans>
        </p>
      )}
      {delayed ? (
        <p className="text-destructive">
          <Trans>Schedule delayed</Trans>
        </p>
      ) : null}
      {lastAttempt ? (
        <p>
          <Trans>Last attempt</Trans>: {date(lastAttempt.at)} ({runStatusLabel(lastAttempt.status)})
        </p>
      ) : null}
      {lastSuccessAt ? (
        <p>
          <Trans>Last successful run</Trans>: {date(lastSuccessAt)}
        </p>
      ) : (
        <p>
          <Trans>No successful runs yet</Trans>
        </p>
      )}
      <label htmlFor={`${fieldId}-delay`} className="flex items-center gap-2">
        <Switch
          id={`${fieldId}-delay`}
          aria-label={t`Delay alerts`}
          checked={health.data.delayAlertsEnabled}
          disabled={alerts.pending}
          onCheckedChange={(value) => setAlert("delayed", value)}
        />
        <Trans>Delay alerts</Trans>
      </label>
      {health.data.delayAlertsEnabled ? (
        <p>
          <Trans>Delay alerts run while the worker is running.</Trans>
        </p>
      ) : null}
      <label htmlFor={`${fieldId}-failure`} className="flex items-center gap-2">
        <Switch
          id={`${fieldId}-failure`}
          aria-label={t`Failure alerts`}
          checked={health.data.failureAlertsEnabled}
          disabled={alerts.pending}
          onCheckedChange={(value) => setAlert("failure", value)}
        />
        <Trans>Failure alerts</Trans>
      </label>
      {health.data.delayAlertResult === "failed" && delayed ? (
        <p className="text-destructive">
          <Trans>Alert could not be sent</Trans>
        </p>
      ) : null}
      {health.data.delayAlertResult === "sent" && delayed ? (
        <p>
          <Trans>Alert accepted; delivery not confirmed</Trans>
        </p>
      ) : null}
      {alerts.error ? (
        <p role="alert">
          <Trans>Could not save</Trans>
        </p>
      ) : null}
    </section>
  );
}
