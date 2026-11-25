import { t } from "@lingui/core/macro";
import { useIsFocused } from "expo-router";
import { Text, View } from "react-native";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n/i18n";
import { useMobileTokens } from "../lib/native/native";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { routineHealthLines } from "../lib/routine-health";
import { NativeSwitch } from "./native/native-switch";

export function RoutineHealth({ routineId }: { routineId: string }) {
  const locale = useUiLocale();
  const tokens = useMobileTokens();
  const focused = useIsFocused();
  const read = rpcQuery("routines/health", { routineId });
  const query = useScreenQuery(read);
  const { refetch } = query;
  useSpaceChanges("routines", refetch, focused);
  useSpaceChanges("runs", refetch, focused);
  const alerts = useSave({
    save: async (input: { field: "delayed" | "failure"; enabled: boolean }, send) =>
      send("routines/setAlerts", {
        routineId,
        [input.field]: input.enabled,
      }),
    stale: [read.queryKey],
  });
  if (query.isError)
    return (
      <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
        {t`Could not load schedule status`}
      </Text>
    );
  if (!query.data) return null;
  const health = query.data;
  const setAlert = (field: "delayed" | "failure", enabled: boolean) =>
    alerts.run({ field, enabled });
  return (
    <View style={{ gap: 8 }}>
      {routineHealthLines(health, dateLocaleForUi(locale)).map((line, index) => (
        <Text key={index} style={{ color: tokens.mutedForeground }}>
          {line}
        </Text>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.foreground }}>{t`Delay alerts`}</Text>
        <NativeSwitch
          accessibilityLabel={t`Delay alerts`}
          disabled={alerts.pending}
          value={health.delayAlertsEnabled}
          onValueChange={(value) => setAlert("delayed", value)}
        />
      </View>
      {health.delayAlertsEnabled ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t`Delay alerts run while the worker is running.`}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.foreground }}>{t`Failure alerts`}</Text>
        <NativeSwitch
          accessibilityLabel={t`Failure alerts`}
          disabled={alerts.pending}
          value={health.failureAlertsEnabled}
          onValueChange={(value) => setAlert("failure", value)}
        />
      </View>
      {health.delayed && health.delayAlertResult === "failed" ? (
        <Text style={{ color: tokens.destructive }}>{t`Alert could not be sent`}</Text>
      ) : null}
      {health.delayed && health.delayAlertResult === "sent" ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t`Alert accepted; delivery not confirmed`}
        </Text>
      ) : null}
      {alerts.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t`Could not save`}
        </Text>
      ) : null}
    </View>
  );
}
