import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { SourceUpdatePreview, SourceUpdateState } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

const POLL_INTERVAL_MS = 1_500;
const MAX_CONFIRMATION_POLLS = 30;
type ReviewedUpdate = {
  currentCommit: string;
  targetCommit: string;
  previousRunStartedAt: string | null;
};

export function SourceUpdates() {
  const { t } = useLingui();
  const [runState, setRunState] = useState<SourceUpdateState | null>(null);
  const [preview, setPreview] = useState<SourceUpdatePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const runStateRef = useRef(runState);
  const awaitingRef = useRef(awaitingConfirmation);
  const applyingRef = useRef(applying);
  const reviewedUpdateRef = useRef<ReviewedUpdate | null>(null);
  const confirmationPolls = useRef(0);

  runStateRef.current = runState;
  awaitingRef.current = awaitingConfirmation;
  applyingRef.current = applying;

  const matchesReviewedUpdate = useCallback((state: SourceUpdateState) => {
    const reviewed = reviewedUpdateRef.current;
    const run = state.lastRun;
    return Boolean(
      reviewed &&
        run &&
        run.startedAt !== reviewed.previousRunStartedAt &&
        run.currentCommit === reviewed.currentCommit &&
        run.targetCommit === reviewed.targetCommit,
    );
  }, []);

  const refreshState = useCallback(
    async (showError = false) => {
      try {
        const next = await rpc.sourceUpdates.state();
        setRunState(next);
        setStatusError(null);
        if (awaitingRef.current && matchesReviewedUpdate(next)) {
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

  useEffect(() => {
    if (!runState?.running && !awaitingConfirmation && !applying) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const next = await refreshState();
      if (stopped) return;
      if (awaitingRef.current) {
        confirmationPolls.current += 1;
        if (!next && confirmationPolls.current >= MAX_CONFIRMATION_POLLS) {
          setAwaitingConfirmation(false);
          setApplyError(
            t`Could not confirm whether the update started. Check again before retrying.`,
          );
        } else if (next && !matchesReviewedUpdate(next)) {
          if (confirmationPolls.current >= MAX_CONFIRMATION_POLLS) {
            setAwaitingConfirmation(false);
            setApplyError(
              t`Could not confirm whether the update started. Check again before retrying.`,
            );
          }
        }
      }
      if (runStateRef.current?.running || awaitingRef.current || applyingRef.current) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runState?.running, awaitingConfirmation, applying, matchesReviewedUpdate, refreshState, t]);

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
      previousRunStartedAt: runState?.lastRun?.startedAt ?? null,
    };
    confirmationPolls.current = 0;
    setApplying(true);
    setPreview(null);
    setCheckError(null);
    setApplyError(null);
    try {
      const run = await rpc.sourceUpdates.apply({
        currentCommit,
        targetCommit,
      });
      reviewedUpdateRef.current = null;
      setRunState({ running: run.finishedAt === null, lastRun: run });
    } catch {
      setAwaitingConfirmation(true);
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
      <SectionHeading>
        <Trans>Official source</Trans>
      </SectionHeading>
      <div className="mt-3 flex justify-end">
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
            <Trans>Updating official source…</Trans>
          ) : (
            <Trans>A source update is in progress.</Trans>
          )}
        </p>
      ) : awaitingConfirmation ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          <Trans>Checking whether the update started…</Trans>
        </p>
      ) : applying && (!runState?.lastRun || !matchesReviewedUpdate(runState)) ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          <Trans>Applying the reviewed update…</Trans>
        </p>
      ) : null}
      {runState?.lastRun &&
      !runState.running &&
      (!reviewedUpdateRef.current || matchesReviewedUpdate(runState)) ? (
        <div
          role={runState.lastRun.ok ? "status" : "alert"}
          className="mt-3 text-sm text-muted-foreground"
        >
          {runState.lastRun.ok ? (
            <Trans>Update complete.</Trans>
          ) : (
            <>
              <p>{runState.lastRun.error ?? t`The update failed.`}</p>
              {runState.lastRun.recovery ? (
                <p className="mt-1">{runState.lastRun.recovery}</p>
              ) : null}
            </>
          )}
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
            {applying ? <Trans>Applying…</Trans> : <Trans>Apply reviewed update</Trans>}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Preview({ preview }: { preview: SourceUpdatePreview }) {
  const { t } = useLingui();
  const summary =
    preview.summaryAvailable && preview.summary
      ? preview.summary
      : t`AI summary unavailable. Review ${plural(preview.commitCount, {
          one: "# official commit",
          other: "# official commits",
        })}.`;
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
      {preview.status === "available" ? (
        <p role="status" className="text-foreground">
          {summary}
        </p>
      ) : preview.status === "up-to-date" ? (
        <p role="status" className="text-muted-foreground">
          <Trans>Rakazo is up to date.</Trans>
        </p>
      ) : preview.status === "conflict" ? (
        <>
          <p role="alert" className="text-destructive">
            {preview.reason ?? t`This update has conflicts and cannot be applied.`}
          </p>
          <p role="status" className="text-foreground">
            {summary}
          </p>
        </>
      ) : preview.status === "running" ? (
        <p role="status" className="text-muted-foreground">
          <Trans>The update is in progress.</Trans>
        </p>
      ) : (
        <p role="status" className="text-muted-foreground">
          {preview.reason ??
            (preview.status === "dirty"
              ? t`Local source changes must be resolved before updating.`
              : t`Official source updates are unavailable.`)}
        </p>
      )}

      {preview.status === "available" || preview.commitCount > 0 || preview.fileCount > 0 ? (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer font-medium text-foreground">
            <Trans>Review changes</Trans>
          </summary>
          <div className="mt-3 flex flex-col gap-3 text-muted-foreground">
            <p>
              {preview.commitCount > 0 ? commitCount : t`No commits`}
              {preview.fileCount > 0 ? ` · ${fileCount}` : ""}
              {preview.branch ? ` · ${preview.branch}` : ""}
            </p>
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
