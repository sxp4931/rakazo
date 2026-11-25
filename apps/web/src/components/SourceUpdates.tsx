import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { SourceUpdatePreview, SourceUpdateState } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/query/rpc";
import { useEventListener } from "../lib/use-event-listener";

type ReviewedUpdate = {
  currentCommit: string;
  targetCommit: string;
  forkCommit?: string;
  previousRunStartedAt: string | null;
};

export function SourceUpdates() {
  const { t } = useLingui();
  const [runState, setRunState] = useState<SourceUpdateState | null>(null);
  const [preview, setPreview] = useState<SourceUpdatePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [refreshingState, setRefreshingState] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const reviewedUpdateRef = useRef<ReviewedUpdate | null>(null);

  const matchesReviewedUpdate = useCallback((state: SourceUpdateState) => {
    const reviewed = reviewedUpdateRef.current;
    const run = state.lastRun;
    return Boolean(
      reviewed &&
        run &&
        run.startedAt !== reviewed.previousRunStartedAt &&
        run.currentCommit === reviewed.currentCommit &&
        run.targetCommit === reviewed.targetCommit &&
        run.forkCommit === reviewed.forkCommit,
    );
  }, []);

  const refreshState = useCallback(
    async (showError = false) => {
      try {
        const next = await rpc.sourceUpdates.state();
        setRunState(next);
        setStatusError(null);
        if (matchesReviewedUpdate(next)) {
          setAwaitingConfirmation(false);
          setApplyError(null);
        }
        return next;
      } catch {
        if (showError) setStatusError(t`Could not load update status.`);
        return null;
      }
    },
    [matchesReviewedUpdate, t],
  );

  useEffect(() => {
    void refreshState(true);
  }, [refreshState]);
  useEventListener(typeof window === "undefined" ? undefined : window, "focus", () => {
    void refreshState();
  });

  async function refreshStatus() {
    setRefreshingState(true);
    try {
      await refreshState();
    } finally {
      setRefreshingState(false);
    }
  }

  async function check() {
    if (checking || applying || runState?.running || awaitingConfirmation) return;
    setChecking(true);
    setCheckError(null);
    setApplyError(null);
    setPreview(null);
    reviewedUpdateRef.current = null;
    try {
      setPreview(await rpc.sourceUpdates.check());
      await refreshState();
    } catch {
      setCheckError(t`Could not check for updates. Try again.`);
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (
      preview?.status !== "available" ||
      preview.commitCount === 0 ||
      applying ||
      runState?.running ||
      awaitingConfirmation
    ) {
      return;
    }

    const currentCommit = preview.currentCommit;
    const targetCommit = preview.targetCommit;
    if (!currentCommit || !targetCommit) return;

    reviewedUpdateRef.current = {
      currentCommit,
      targetCommit,
      forkCommit: preview.forkCommit,
      previousRunStartedAt: runState?.lastRun?.startedAt ?? null,
    };
    setApplying(true);
    setPreview(null);
    setCheckError(null);
    setApplyError(null);
    try {
      const run = await rpc.sourceUpdates.apply({
        currentCommit,
        targetCommit,
        ...(preview.forkCommit ? { forkCommit: preview.forkCommit } : {}),
      });
      reviewedUpdateRef.current = null;
      setRunState({ running: run.finishedAt === null, lastRun: run });
    } catch {
      setAwaitingConfirmation(true);
      const next = await refreshState();
      if (next && matchesReviewedUpdate(next)) {
        setAwaitingConfirmation(false);
        setApplyError(null);
      }
    } finally {
      setApplying(false);
    }
  }

  const canApply = Boolean(
    preview?.status === "available" &&
      preview.currentCommit &&
      preview.targetCommit &&
      preview.commitCount > 0 &&
      !runState?.running &&
      !awaitingConfirmation,
  );

  return (
    <section
      data-testid="source-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading>
          <Trans>Source updates</Trans>
        </SectionHeading>
        <Button
          variant="outline"
          disabled={checking || applying || runState?.running || awaitingConfirmation}
          onClick={() => void check()}
        >
          {checking ? <Trans>Checking…</Trans> : <Trans>Check for updates</Trans>}
        </Button>
      </div>

      {runState?.running ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {reviewedUpdateRef.current && matchesReviewedUpdate(runState) ? (
            <Trans>Installing update…</Trans>
          ) : (
            <Trans>A source update is in progress.</Trans>
          )}
        </p>
      ) : awaitingConfirmation ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          <Trans>Update status is unconfirmed.</Trans>
        </p>
      ) : applying && (!runState?.lastRun || !matchesReviewedUpdate(runState)) ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          <Trans>Applying the reviewed update…</Trans>
        </p>
      ) : null}
      {runState?.running || awaitingConfirmation ? (
        <div className="mt-3 flex justify-end">
          <Button variant="outline" disabled={refreshingState} onClick={() => void refreshStatus()}>
            {refreshingState ? <Trans>Checking…</Trans> : <Trans>Refresh status</Trans>}
          </Button>
        </div>
      ) : null}
      {runState?.lastRun &&
      !runState.running &&
      (!reviewedUpdateRef.current || matchesReviewedUpdate(runState)) ? (
        <div
          role={runState.lastRun.ok ? "status" : "alert"}
          className="mt-3 text-sm text-muted-foreground"
        >
          <p>
            {runState.lastRun.ok
              ? t`Update complete.`
              : (runState.lastRun.error ?? t`The update failed.`)}
          </p>
          {runState.lastRun.recovery ? <p className="mt-1">{runState.lastRun.recovery}</p> : null}
        </div>
      ) : null}

      {statusError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {statusError}
        </p>
      ) : null}
      {checkError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {checkError}
        </p>
      ) : null}
      {applyError && !awaitingConfirmation ? (
        <p role="alert" className="mt-3 text-sm">
          {applyError}
        </p>
      ) : null}

      {preview ? <Preview preview={preview} /> : null}
      {preview?.status === "available" ? (
        <div className="mt-3 flex justify-end">
          <Button disabled={!canApply || applying} onClick={() => void apply()}>
            <Trans>Install update</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Preview({ preview }: { preview: SourceUpdatePreview }) {
  const { t } = useLingui();
  const commitCount = t`${plural(preview.commitCount, {
    one: "# commit",
    other: "# commits",
  })}`;
  const fileCount = t`${plural(preview.fileCount, {
    one: "# file changed",
    other: "# files changed",
  })}`;
  const changedFiles =
    preview.changedFiles.length > 0 ? preview.changedFiles : preview.changedPaths;

  return (
    <div className="mt-3 flex flex-col gap-3 text-sm">
      {preview.status === "up-to-date" ? (
        <p role="status" className="text-muted-foreground">
          <Trans>Rakazo is up to date.</Trans>
        </p>
      ) : preview.status === "conflict" ? (
        <p role="alert" className="text-destructive">
          {preview.reason ?? t`This update has conflicts and cannot be applied.`}
        </p>
      ) : preview.status === "running" ? (
        <p role="status" className="text-muted-foreground">
          <Trans>The update is in progress.</Trans>
        </p>
      ) : preview.status !== "available" ? (
        <p role="status" className="text-muted-foreground">
          {preview.reason ??
            (preview.status === "dirty"
              ? t`Local source changes must be resolved before updating.`
              : t`Official source updates are unavailable.`)}
        </p>
      ) : null}

      {preview.forkCommit && preview.status === "available" ? (
        <p role="status" className="text-muted-foreground">
          <Trans>Update ready from your branch.</Trans>
        </p>
      ) : null}
      {preview.status === "available" || preview.status === "conflict" ? (
        preview.summary ? (
          <p className="whitespace-pre-line text-foreground">{preview.summary}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-foreground">
            {preview.commits.slice(0, 3).map(({ commit, subject }) => (
              <li key={commit}>{subject}</li>
            ))}
          </ul>
        )
      ) : null}

      {preview.status === "available" || preview.commitCount > 0 || preview.fileCount > 0 ? (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer font-medium text-foreground">
            <Trans>Review changes</Trans>
          </summary>
          <div className="mt-3 flex flex-col gap-3 text-muted-foreground">
            <div>
              <p>{preview.commitCount > 0 ? commitCount : t`No commits`}</p>
              {preview.fileCount > 0 ? <p>{fileCount}</p> : null}
              {preview.branch ? <p>{preview.branch}</p> : null}
            </div>
            {preview.currentCommit && preview.targetCommit ? (
              <p className="font-mono text-xs">
                <Trans>Current</Trans> {preview.currentCommit.slice(0, 8)} → <Trans>Target</Trans>{" "}
                {preview.targetCommit.slice(0, 8)}
              </p>
            ) : null}
            {preview.commits.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {preview.commits.map((commit) => (
                  <li key={commit.commit}>
                    <span className="font-mono text-xs">{commit.commit.slice(0, 8)}</span>{" "}
                    {commit.subject}
                  </li>
                ))}
              </ul>
            ) : null}
            {changedFiles.length > 0 ? (
              <div>
                <p className="font-medium text-foreground">
                  <Trans>Changed files</Trans>
                </p>
                <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
                  {changedFiles.map((path) => (
                    <li key={path} className="break-all font-mono text-xs">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.conflictingPaths.length > 0 ? (
              <div>
                <p className="font-medium text-destructive">
                  <Trans>Conflicts</Trans>
                </p>
                <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-destructive">
                  {preview.conflictingPaths.map((path) => (
                    <li key={path} className="break-all font-mono text-xs">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
