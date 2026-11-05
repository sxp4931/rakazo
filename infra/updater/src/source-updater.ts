import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SourceUpdateRun, SourceUpdateState } from "@rakazo/contracts";
import { SourceUpdateRunSchema } from "@rakazo/contracts";
import {
  DEFAULT_UPDATE_BRANCH,
  isGitCommit,
  OFFICIAL_REPO_URL,
  parseGitStatusPorcelain,
} from "@rakazo/core";
import type { CommandResult } from "./index.js";

const RUNTIME_SUPPORT_ROOTS = new Set([".config", ".local", ".npm", ".pnpm", ".state"]);
const DIFF_LIMIT = 60_000;
const COMMIT_LIMIT = 100;
const GIT_TIMEOUT_MS = 3 * 60_000;
const PNPM_TIMEOUT_MS = 20 * 60_000;

export type SourceUpdateCommand =
  | "git"
  | "pnpm"
  | "backup"
  | "restart"
  | "health"
  | "reload-helper";

export type SourceUpdateCommandRunner = (
  command: SourceUpdateCommand,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<CommandResult>;

export interface SourceUpdateCandidate {
  status: "unavailable" | "dirty" | "up-to-date" | "available" | "conflict" | "running";
  reason: string | null;
  currentCommit: string | null;
  targetCommit: string | null;
  branch: string | null;
  changedPaths: string[];
  conflictingPaths: string[];
  commits: Array<{ commit: string; subject: string }>;
  commitCount: number;
  changedFiles: string[];
  fileCount: number;
  mergeCommit: string | null;
  /** Bounded upstream-only diff sent to the configured model; never returned to clients. */
  diff: string;
}

export interface SourceUpdaterConfig {
  deployDir: string;
  statePath: string;
  backupDir?: string;
  officialRepoUrl?: string;
  branch?: string;
  run?: SourceUpdateCommandRunner;
}

export function isPreservedRuntimePath(file: string): boolean {
  return RUNTIME_SUPPORT_ROOTS.has(file.split("/")[0] ?? "");
}

function failure(
  reason: string,
  values: Partial<SourceUpdateCandidate> = {},
): SourceUpdateCandidate {
  return {
    status: "unavailable",
    reason,
    currentCommit: null,
    targetCommit: null,
    branch: null,
    changedPaths: [],
    conflictingPaths: [],
    commits: [],
    commitCount: 0,
    changedFiles: [],
    fileCount: 0,
    mergeCommit: null,
    diff: "",
    ...values,
  };
}

function parseNulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function overlapsPath(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function findUntrackedConflicts(
  git: (args: string[]) => Promise<CommandResult>,
  untracked: string[],
  targetFiles: string[],
): Promise<string[]> {
  const conflicts: string[] = [];
  for (let offset = 0; offset < targetFiles.length; offset += 100) {
    const targets = targetFiles.slice(offset, offset + 100);
    const ignored = await git([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...targets.map((file) => `:(literal)${file}`),
    ]);
    if (!ignored.ok) return targets;
    const untrackedPaths = [...untracked, ...parseNulList(ignored.stdout)];
    conflicts.push(
      ...targets.filter((target) => untrackedPaths.some((file) => overlapsPath(file, target))),
    );
  }
  return [...new Set(conflicts)];
}

export function createSourceUpdater(config: SourceUpdaterConfig) {
  const run = config.run ?? defaultSourceUpdateCommand;
  const repoUrl = config.officialRepoUrl ?? OFFICIAL_REPO_URL;
  const branch = config.branch ?? DEFAULT_UPDATE_BRANCH;
  let running = false;
  let lastRun: SourceUpdateRun | null = null;

  return {
    state(): SourceUpdateState {
      return { running, lastRun };
    },

    async loadState() {
      await readCandidateState();
    },

    async check(
      pinnedCommit?: string,
      allowRunning = false,
      validateBuild = false,
      retainedCandidate?: { directory?: string; mergeCommit?: string },
    ): Promise<SourceUpdateCandidate> {
      if (lastRun?.stage === "interrupted" || lastRun?.stage === "recovery-failed") {
        return failure(
          "A previous update could not be confirmed. Review the last run and recover the source before checking again.",
          { currentCommit: lastRun.currentCommit, targetCommit: lastRun.targetCommit },
        );
      }
      if (running && !allowRunning) {
        return failure("An update is already running.", { status: "running" });
      }
      if (!path.isAbsolute(config.deployDir)) return failure("The source checkout is unavailable.");

      const [top, head, currentBranch, trackedStatus, untrackedResult, mergeHead] =
        await Promise.all([
          git(["rev-parse", "--show-toplevel"]),
          git(["rev-parse", "HEAD"]),
          git(["rev-parse", "--abbrev-ref", "HEAD"]),
          git(["status", "--porcelain", "--untracked-files=no"]),
          git(["ls-files", "--others", "--exclude-standard", "-z"]),
          git(["rev-parse", "--verify", "MERGE_HEAD"]),
        ]);
      const currentCommit = head.ok ? head.stdout.trim() : "";
      const checkoutPath = await realpath(config.deployDir).catch(() => "");
      if (!top.ok || path.resolve(top.stdout.trim()) !== path.resolve(checkoutPath)) {
        return failure("The source checkout could not be verified.");
      }
      if (
        !isGitCommit(currentCommit) ||
        !currentBranch.ok ||
        !trackedStatus.ok ||
        !untrackedResult.ok
      ) {
        return failure("The source checkout could not be read.");
      }
      if (mergeHead.ok) {
        return failure("Finish the Git operation already in progress before checking updates.", {
          currentCommit,
          branch: currentBranch.stdout.trim(),
        });
      }

      const trackedChanges = parseGitStatusPorcelain(trackedStatus.stdout).changed;
      const untracked = parseNulList(untrackedResult.stdout);
      const localChanges = [
        ...trackedChanges,
        ...untracked.filter((file) => !isPreservedRuntimePath(file)),
      ];
      if (localChanges.length > 0) {
        return failure("Commit or move the local source changes before checking updates.", {
          status: "dirty",
          currentCommit,
          branch: currentBranch.stdout.trim(),
          changedPaths: [...new Set(localChanges)].slice(0, 300),
        });
      }

      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rakazo-source-update-"));
      const owner = await lstat(config.deployDir);
      if (!owner.isDirectory() || owner.isSymbolicLink()) {
        await rm(tempRoot, { recursive: true, force: true });
        return failure("The source checkout could not be verified.");
      }
      await chown(tempRoot, owner.uid, owner.gid);
      const candidateDir = path.join(tempRoot, "candidate");
      const candidateGit = (args: string[]) =>
        run("git", args, { cwd: candidateDir, timeoutMs: GIT_TIMEOUT_MS });
      let keepCandidate = false;
      try {
        const cloned = await run(
          "git",
          [
            "clone",
            "--shared",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            config.deployDir,
            candidateDir,
          ],
          {
            cwd: tempRoot,
            timeoutMs: GIT_TIMEOUT_MS,
          },
        );
        if (!cloned.ok) return failure("A temporary review checkout could not be created.");
        const checkout = await candidateGit(["checkout", "--detach", currentCommit]);
        if (!checkout.ok) return failure("A temporary review checkout could not be prepared.");
        const fetched = await candidateGit([
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          repoUrl,
          `refs/heads/${branch}`,
        ]);
        if (!fetched.ok) return failure("Could not reach the official source repository.");
        const remoteHeadResult = await candidateGit(["rev-parse", "FETCH_HEAD^{commit}"]);
        const remoteHead = remoteHeadResult.ok ? remoteHeadResult.stdout.trim() : "";
        if (!isGitCommit(remoteHead))
          return failure("The official branch did not return a commit.");

        let targetCommit = remoteHead;
        if (pinnedCommit !== undefined) {
          if (!isGitCommit(pinnedCommit)) return failure("The reviewed commit is invalid.");
          const stillOfficial = await candidateGit([
            "merge-base",
            "--is-ancestor",
            pinnedCommit,
            remoteHead,
          ]);
          if (!stillOfficial.ok) {
            return failure(
              "The reviewed commit is no longer on the official branch. Check again.",
              {
                currentCommit,
                targetCommit: remoteHead,
                branch: currentBranch.stdout.trim(),
              },
            );
          }
          targetCommit = pinnedCommit;
        }

        const baseResult = await candidateGit(["merge-base", currentCommit, targetCommit]);
        const base = baseResult.ok ? baseResult.stdout.trim() : "";
        if (!isGitCommit(base)) {
          return failure("The checkout and official source have no common commit.", {
            currentCommit,
            targetCommit,
            branch: currentBranch.stdout.trim(),
          });
        }
        if (base === targetCommit) {
          if (
            lastRun?.targetCommit === targetCommit &&
            !lastRun.ok &&
            (lastRun.stage === "rolled-back" || lastRun.stage === "recovery-failed")
          ) {
            return failure(
              "This update was rolled back after a failed install and cannot be reapplied automatically. Review the last run and recover the source backup.",
              {
                currentCommit,
                targetCommit,
                branch: currentBranch.stdout.trim(),
              },
            );
          }
          return failure("The checkout already contains the official changes.", {
            status: "up-to-date",
            reason: null,
            currentCommit,
            targetCommit,
            branch: currentBranch.stdout.trim(),
          });
        }

        const [fileResult, logResult, countResult, diffResult] = await Promise.all([
          candidateGit(["diff", "--name-only", "--no-renames", base, targetCommit]),
          candidateGit([
            "log",
            "--no-decorate",
            "--format=%H%x1f%s",
            `--max-count=${COMMIT_LIMIT}`,
            `${base}..${targetCommit}`,
          ]),
          candidateGit(["rev-list", "--count", `${base}..${targetCommit}`]),
          candidateGit([
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--unified=2",
            base,
            targetCommit,
          ]),
        ]);
        if (!fileResult.ok || !logResult.ok || !countResult.ok || !diffResult.ok) {
          return failure("The official changes could not be summarized.", {
            currentCommit,
            targetCommit,
            branch: currentBranch.stdout.trim(),
          });
        }
        const changedFiles = [...new Set(fileResult.stdout.split("\n").filter(Boolean))];
        const untrackedConflicts = await findUntrackedConflicts(git, untracked, changedFiles);
        const commits = logResult.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [commit = "", ...subject] = line.split("\x1f");
            return { commit, subject: subject.join("\x1f").slice(0, 300) };
          })
          .filter((entry) => isGitCommit(entry.commit));
        const shared = {
          currentCommit,
          targetCommit,
          branch: currentBranch.stdout.trim(),
          commits,
          commitCount: Number(countResult.stdout.trim()) || commits.length,
          changedFiles: changedFiles.slice(0, 300),
          fileCount: changedFiles.length,
          diff: diffResult.stdout.slice(0, DIFF_LIMIT),
        };
        if (untrackedConflicts.length > 0) {
          return failure("An upstream file would overwrite a local ignored or runtime file.", {
            status: "conflict",
            conflictingPaths: untrackedConflicts.slice(0, 300),
            ...shared,
          });
        }

        const merged = await candidateGit([
          "-c",
          "user.name=Rakazo",
          "-c",
          "user.email=updates@rakazo.local",
          "-c",
          "core.hooksPath=/dev/null",
          "merge",
          "--no-ff",
          "--no-edit",
          targetCommit,
        ]);
        if (!merged.ok) {
          const conflicts = await candidateGit(["diff", "--name-only", "--diff-filter=U"]);
          await candidateGit(["merge", "--abort"]);
          return failure("The upstream changes conflict with this customized checkout.", {
            status: "conflict",
            conflictingPaths: conflicts.ok
              ? conflicts.stdout.split("\n").filter(Boolean).slice(0, 300)
              : [],
            ...shared,
          });
        }
        const mergeHead = await candidateGit(["rev-parse", "HEAD"]);
        const mergeCommit = mergeHead.ok ? mergeHead.stdout.trim() : "";
        if (!isGitCommit(mergeCommit)) {
          return failure("The isolated merge commit could not be verified.", shared);
        }
        if (validateBuild) {
          for (const step of [
            ["install", ["install", "--frozen-lockfile", "--prod=false"]],
            ["generate", ["db:generate"]],
            [
              "check",
              [
                "exec",
                "turbo",
                "run",
                "check",
                "--concurrency=1",
                "--filter=@rakazo/api",
                "--filter=@rakazo/worker",
                "--filter=@rakazo/web",
              ],
            ],
            [
              "build",
              [
                "exec",
                "turbo",
                "run",
                "build",
                "--concurrency=1",
                "--filter=@rakazo/api",
                "--filter=@rakazo/worker",
                "--filter=@rakazo/web",
              ],
            ],
          ] as const) {
            const result = await run("pnpm", [...step[1]], {
              cwd: candidateDir,
              timeoutMs: PNPM_TIMEOUT_MS,
              env: safePnpmEnvironment(process.env, false),
            });
            if (!result.ok) {
              return failure(
                `The isolated candidate ${step[0]} step failed. The live checkout was not changed.`,
                {
                  currentCommit,
                  targetCommit,
                  branch: currentBranch.stdout.trim(),
                  commits,
                  commitCount: Number(countResult.stdout.trim()) || commits.length,
                  changedFiles: changedFiles.slice(0, 300),
                  fileCount: changedFiles.length,
                  diff: diffResult.stdout.slice(0, DIFF_LIMIT),
                },
              );
            }
          }
        }
        if (retainedCandidate) {
          retainedCandidate.directory = candidateDir;
          retainedCandidate.mergeCommit = mergeCommit;
          keepCandidate = true;
        }
        return {
          status: "available",
          reason: null,
          changedPaths: [],
          conflictingPaths: [],
          ...shared,
          mergeCommit,
        };
      } finally {
        if (!keepCandidate) await rm(tempRoot, { recursive: true, force: true });
      }
    },

    async apply(input: { currentCommit: string; targetCommit: string }): Promise<SourceUpdateRun> {
      if (running) throw new Error("An update is already running.");
      if (lastRun?.stage === "interrupted" || lastRun?.stage === "recovery-failed") {
        throw new Error(
          "A previous update could not be confirmed. Recover the source before applying another update.",
        );
      }
      if (!isGitCommit(input.currentCommit) || !isGitCommit(input.targetCommit)) {
        throw new Error("The reviewed source revision is invalid.");
      }
      if (lastRun?.stage === "rolled-back" && lastRun.targetCommit === input.targetCommit) {
        throw new Error(
          "This reviewed update was rolled back and cannot be reapplied automatically.",
        );
      }
      running = true;
      const startedAt = new Date().toISOString();
      const current = input.currentCommit;
      const target = input.targetCommit;
      const retainedCandidate: { directory?: string; mergeCommit?: string } = {};
      let sourceBackupCreated = false;
      let backupCreated = false;
      const nextRun: SourceUpdateRun = {
        startedAt,
        finishedAt: null,
        ok: false,
        currentCommit: current,
        targetCommit: target,
        stage: "checking",
        error: null,
        recovery: null,
      };
      lastRun = nextRun;
      let mergeCommit: string | null = null;

      try {
        await persist();
        const reviewed = await this.check(target, true, true, retainedCandidate);
        if (
          reviewed.status !== "available" ||
          reviewed.currentCommit !== current ||
          reviewed.targetCommit !== target
        ) {
          throw new Error(reviewed.reason ?? "The checkout changed after review. Check again.");
        }

        nextRun.stage = "backup";
        await persist();
        const backupDir =
          config.backupDir ?? path.join(config.deployDir, ".state", "source-update-backups");
        await mkdir(backupDir, { recursive: true, mode: 0o700 });
        const backupPath = path.join(
          backupDir,
          `source-${Date.now()}-${randomBytes(4).toString("hex")}.bundle`,
        );
        const currentHead = await git(["rev-parse", "HEAD"]);
        if (!currentHead.ok || currentHead.stdout.trim() !== current) {
          throw new Error("The checkout changed after review. Check again before applying.");
        }
        const sourceBackup = await run("git", ["bundle", "create", backupPath, "HEAD"], {
          cwd: config.deployDir,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (!sourceBackup.ok) throw new Error("Could not create a source recovery bundle.");
        const verifiedBundle = await run("git", ["bundle", "verify", backupPath], {
          cwd: config.deployDir,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (!verifiedBundle.ok)
          throw new Error("The source recovery bundle could not be verified.");
        sourceBackupCreated = true;
        const databaseBackup = await run("backup", [], {
          cwd: config.deployDir,
          timeoutMs: 15 * 60_000,
        });
        if (!databaseBackup.ok) throw new Error("The database and data backup did not complete.");
        backupCreated = true;

        const fetched = await git([
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          repoUrl,
          `refs/heads/${branch}`,
        ]);
        if (!fetched.ok) throw new Error("Could not fetch the reviewed official commit.");
        const stillOfficial = await git(["merge-base", "--is-ancestor", target, "FETCH_HEAD"]);
        if (!stillOfficial.ok)
          throw new Error("The reviewed commit is no longer on the official branch.");
        if (!retainedCandidate.directory || !isGitCommit(retainedCandidate.mergeCommit ?? "")) {
          throw new Error("The isolated source candidate could not be retained for activation.");
        }
        const head = await git(["rev-parse", "HEAD"]);
        if (!head.ok || head.stdout.trim() !== current) {
          throw new Error("The checkout changed after review. Check again before applying.");
        }
        const [trackedStatus, untrackedStatus, mergeHead] = await Promise.all([
          git(["status", "--porcelain", "--untracked-files=no"]),
          git(["ls-files", "--others", "--exclude-standard", "-z"]),
          git(["rev-parse", "--verify", "MERGE_HEAD"]),
        ]);
        const remainingChanges = [
          ...(trackedStatus.ok
            ? parseGitStatusPorcelain(trackedStatus.stdout).changed
            : ["tracked status unavailable"]),
          ...(untrackedStatus.ok
            ? parseNulList(untrackedStatus.stdout).filter((file) => !isPreservedRuntimePath(file))
            : ["untracked status unavailable"]),
        ];
        if (
          !trackedStatus.ok ||
          !untrackedStatus.ok ||
          mergeHead.ok ||
          remainingChanges.length > 0
        ) {
          throw new Error(
            "The checkout changed during the candidate build. Review the local changes and check again.",
          );
        }

        nextRun.stage = "merging";
        await persist();
        const importedCandidate = await git([
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          retainedCandidate.directory,
          "HEAD",
        ]);
        const importedHead = importedCandidate.ok ? await git(["rev-parse", "FETCH_HEAD"]) : null;
        if (
          !importedCandidate.ok ||
          !importedHead?.ok ||
          importedHead.stdout.trim() !== retainedCandidate.mergeCommit
        ) {
          throw new Error("The prepared source merge could not be imported safely.");
        }
        const activated = await git([
          "merge",
          "--ff-only",
          "--no-overwrite-ignore",
          "--no-edit",
          retainedCandidate.mergeCommit,
        ]);
        if (!activated.ok) {
          throw new Error(
            "The checkout changed during the candidate build. Review local changes and check again.",
          );
        }
        mergeCommit = retainedCandidate.mergeCommit;
        const mergedHead = await git(["rev-parse", "HEAD"]);
        if (!mergedHead.ok || mergedHead.stdout.trim() !== mergeCommit) {
          throw new Error("The prepared source revision was not activated exactly.");
        }
        const [postMergeTracked, postMergeUntracked] = await Promise.all([
          git(["status", "--porcelain", "--untracked-files=no"]),
          git(["ls-files", "--others", "--exclude-standard", "-z"]),
        ]);
        const postMergeChanges = [
          ...(postMergeTracked.ok
            ? parseGitStatusPorcelain(postMergeTracked.stdout).changed
            : ["tracked status unavailable"]),
          ...(postMergeUntracked.ok
            ? parseNulList(postMergeUntracked.stdout).filter(
                (file) => !isPreservedRuntimePath(file),
              )
            : ["untracked status unavailable"]),
        ];
        if (!postMergeTracked.ok || !postMergeUntracked.ok || postMergeChanges.length > 0) {
          throw new Error("Local files changed as the prepared source revision was activated.");
        }

        nextRun.stage = "install";
        await persist();
        for (const step of [
          ["install", ["install", "--frozen-lockfile", "--prod=false"]],
          ["generate", ["db:generate"]],
          [
            "build",
            [
              "exec",
              "turbo",
              "run",
              "build",
              "--concurrency=1",
              "--filter=@rakazo/api",
              "--filter=@rakazo/worker",
              "--filter=@rakazo/web",
            ],
          ],
          ["migrate", ["db:migrate"]],
        ] as const) {
          nextRun.stage = step[0];
          await persist();
          const result = await run("pnpm", [...step[1]], {
            cwd: config.deployDir,
            timeoutMs: PNPM_TIMEOUT_MS,
            env: safePnpmEnvironment(process.env, step[0] === "migrate"),
          });
          if (!result.ok) throw new Error(`The ${step[0]} step failed.`);
        }

        nextRun.stage = "restart";
        const restarted = await run("restart", [], {
          cwd: config.deployDir,
          timeoutMs: 120_000,
        });
        if (!restarted.ok) throw new Error("The new source built, but services did not restart.");
        nextRun.stage = "health";
        await persist();
        const healthy = await run("health", [], {
          cwd: config.deployDir,
          timeoutMs: 160_000,
        });
        if (!healthy.ok) throw new Error("The API did not report healthy after the restart.");
        nextRun.ok = true;
        nextRun.finishedAt = new Date().toISOString();
        lastRun = nextRun;
        await persist(false);
        nextRun.error = null;
        nextRun.recovery = null;
      } catch (error) {
        nextRun.ok = false;
        nextRun.error =
          error instanceof Error ? error.message.slice(0, 500) : "The source update failed.";
        if (mergeCommit !== null) {
          const reverted = await git([
            "-c",
            "user.name=Rakazo",
            "-c",
            "user.email=updates@rakazo.local",
            "-c",
            "core.hooksPath=/dev/null",
            "revert",
            "--no-edit",
            "-m",
            "1",
            mergeCommit,
          ]);
          if (reverted.ok) {
            nextRun.stage = "rolled-back";
            await persist();
            const recoveryBuild = await run(
              "pnpm",
              ["install", "--frozen-lockfile", "--prod=false"],
              {
                cwd: config.deployDir,
                timeoutMs: PNPM_TIMEOUT_MS,
                env: safePnpmEnvironment(process.env, false),
              },
            );
            const recoveryGenerate = recoveryBuild.ok
              ? await run("pnpm", ["db:generate"], {
                  cwd: config.deployDir,
                  timeoutMs: PNPM_TIMEOUT_MS,
                  env: safePnpmEnvironment(process.env, false),
                })
              : { ok: false };
            const recoveryBuildResult = recoveryGenerate.ok
              ? await run(
                  "pnpm",
                  [
                    "exec",
                    "turbo",
                    "run",
                    "build",
                    "--concurrency=1",
                    "--filter=@rakazo/api",
                    "--filter=@rakazo/worker",
                    "--filter=@rakazo/web",
                  ],
                  {
                    cwd: config.deployDir,
                    timeoutMs: PNPM_TIMEOUT_MS,
                    env: safePnpmEnvironment(process.env, false),
                  },
                )
              : { ok: false };
            const recoveryRestart = recoveryBuildResult.ok
              ? await run("restart", [], { cwd: config.deployDir, timeoutMs: 120_000 })
              : { ok: false };
            const recoveryHealthy = recoveryRestart.ok
              ? await run("health", [], { cwd: config.deployDir, timeoutMs: 160_000 })
              : { ok: false };
            nextRun.recovery = recoveryHealthy.ok
              ? "The source merge was reverted and the previous services restarted. Database migrations are not reversed."
              : "The source bundle and database backup are available for manual recovery; services may need a restart. Database migrations are not reversed.";
          } else {
            nextRun.stage = "recovery-failed";
            await persist();
            nextRun.recovery =
              "The source bundle and database backup are available; automatic source recovery failed.";
          }
        } else {
          nextRun.recovery = backupCreated
            ? "The live source was not changed. The source bundle and database backup are available."
            : sourceBackupCreated
              ? "The live source was not changed. The source bundle remains available; the database backup did not complete."
              : "The live source was not changed; no update was applied.";
        }
      } finally {
        nextRun.finishedAt = new Date().toISOString();
        running = false;
        lastRun = nextRun;
        try {
          await persist();
        } finally {
          if (retainedCandidate.directory) {
            await rm(path.dirname(retainedCandidate.directory), { recursive: true, force: true });
          }
        }
      }

      if (nextRun.ok) {
        // The completed run is on disk before the unprivileged service loads the new checkout.
        const helperRestart = await run("reload-helper", [], {
          cwd: config.deployDir,
          timeoutMs: 120_000,
        });
        if (!helperRestart.ok) {
          nextRun.recovery =
            "The update completed; the source updater will reload after its next restart.";
          lastRun = nextRun;
          await persist(false);
        }
      }

      return nextRun;
    },
  };

  async function git(args: string[]) {
    return run("git", args, { cwd: config.deployDir, timeoutMs: GIT_TIMEOUT_MS });
  }

  async function persist(stateRunning = running) {
    await mkdir(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${config.statePath}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(temporary, JSON.stringify({ running: stateRunning, lastRun }), { mode: 0o600 });
    await rename(temporary, config.statePath);
  }

  async function readCandidateState() {
    try {
      const saved = JSON.parse(
        await readFile(config.statePath, "utf8"),
      ) as Partial<SourceUpdateState>;
      lastRun = SourceUpdateRunSchema.nullable().parse(saved.lastRun ?? null);
      // A process restart in the middle of a run leaves its outcome uncertain.
      if (saved.running && lastRun) {
        lastRun = {
          ...lastRun,
          finishedAt: new Date().toISOString(),
          ok: false,
          stage: "interrupted",
          error: "The update service restarted before the run finished.",
          recovery: "Check the source checkout and service health before trying again.",
        };
      }
      running = false;
      await persist();
    } catch {
      running = false;
      lastRun = null;
    }
  }
}

function safePnpmEnvironment(
  source: NodeJS.ProcessEnv,
  includeDatabase: boolean,
): Record<string, string> {
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_ENV",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT",
    "PNPM_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "API_URL",
    "WEB_ORIGIN",
    "RAKAZO_HOST",
    "API_PORT",
    "WEB_PORT",
    "API_PROXY_TARGET",
  ];
  if (includeDatabase) keys.push("DATABASE_URL", "DATABASE_MIGRATION_URL");
  return {
    ...Object.fromEntries(
      keys
        .filter((key) => key !== "HOME")
        .flatMap((key) => (source[key] ? [[key, source[key]!]] : [])),
    ),
    HOME: os.homedir(),
  };
}

export function createSourceUpdaterCommandRunner(
  source: NodeJS.ProcessEnv,
): SourceUpdateCommandRunner {
  return async (command, args, options) => {
    if (command === "git" || command === "pnpm") {
      return execFileResult(command, args, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env ?? safeGitEnvironment(source),
      });
    }
    const actions = {
      backup: "backup",
      restart: "restart",
      "reload-helper": "reload-updater",
    } as const;
    if (command === "health") return waitForApiHealth(options.timeoutMs);
    const action = actions[command];
    return hostControlRequest(source, action, options.timeoutMs);
  };
}

async function hostControlRequest(
  source: NodeJS.ProcessEnv,
  action: "backup" | "restart" | "reload-updater",
  timeoutMs: number,
): Promise<CommandResult> {
  const token = source.RAKAZO_HOST_CONTROL_TOKEN;
  if (!token)
    return { ok: false, exitCode: null, stdout: "", output: "Host control is unavailable." };
  try {
    const response = await fetch(`http://127.0.0.1:7094/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { ok: true, exitCode: 0, stdout: "", output: "" }
      : {
          ok: false,
          exitCode: response.status,
          stdout: "",
          output: "Host control refused the action.",
        };
  } catch {
    return { ok: false, exitCode: null, stdout: "", output: "Host control could not be reached." };
  }
}

function safeGitEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return {
    ...Object.fromEntries(keys.flatMap((key) => (source[key] ? [[key, source[key]!]] : []))),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    CI: "1",
  };
}

async function waitForApiHealth(timeoutMs: number): Promise<CommandResult> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 750));
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3100/health", {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return { ok: true, exitCode: 0, stdout: "", output: "" };
      }
    } catch {
      /* The API is expected to be unavailable while systemd restarts it. */
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { ok: false, exitCode: null, stdout: "", output: "The API health check timed out." };
}

function execFileResult(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG, ...options.env },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trimEnd();
        resolve({
          ok: !error,
          exitCode: error && typeof error.code === "number" ? error.code : error ? null : 0,
          stdout: String(stdout),
          output: output.length > 8_000 ? output.slice(-8_000) : output,
        });
      },
    );
  });
}

async function defaultSourceUpdateCommand(
  command: SourceUpdateCommand,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> {
  return createSourceUpdaterCommandRunner(process.env)(command, args, options);
}
