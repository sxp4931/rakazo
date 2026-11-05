import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceUpdateCommand, SourceUpdateCommandRunner } from "./source-updater.js";
import { createSourceUpdater } from "./source-updater.js";

const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("official source updates", () => {
  it("merges upstream into local commits and verifies a recovery bundle without changing origin", async () => {
    const fixture = await makeFixture();
    const installs: string[][] = [];
    const candidatePnpm: string[][] = [];
    const updater = createSourceUpdater(
      fixture.config({
        run: commandRunner((args, cwd) => {
          if (args[0] === "install") installs.push(args);
          if (cwd.endsWith(`${path.sep}candidate`)) candidatePnpm.push(args);
        }),
      }),
    );
    const preview = await updater.check();
    expect(preview.status, JSON.stringify(preview)).toBe("available");
    expect(preview.currentCommit).toBe(fixture.localHead);
    expect(preview.targetCommit).toBe(fixture.upstreamHead);
    expect((await git(fixture.repo, ["remote", "get-url", "origin"])).trim()).toBe(fixture.forkUrl);
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(fixture.localHead);

    const applied = await updater.apply({
      currentCommit: fixture.localHead,
      targetCommit: fixture.upstreamHead,
    });
    expect(applied.ok).toBe(true);
    expect(installs.length).toBeGreaterThanOrEqual(2);
    expect(installs.every((args) => args.includes("--prod=false"))).toBe(true);
    expect(candidatePnpm).toEqual([
      ["install", "--frozen-lockfile", "--prod=false"],
      ["db:generate"],
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
    ]);
    expect(await readFile(path.join(fixture.repo, "local.txt"), "utf8")).toBe("custom\n");
    expect(await readFile(path.join(fixture.repo, "upstream.txt"), "utf8")).toBe("official\n");
    expect(
      await git(fixture.repo, ["merge-base", "--is-ancestor", fixture.localHead, "HEAD"]),
    ).toBe("");
    expect((await git(fixture.repo, ["remote", "get-url", "origin"])).trim()).toBe(fixture.forkUrl);

    const bundles = await readdir(fixture.backupDir);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatch(/\.bundle$/);
    await git(fixture.repo, ["bundle", "verify", path.join(fixture.backupDir, bundles[0]!)]);

    const restartedUpdater = createSourceUpdater(fixture.config({ run: commandRunner() }));
    await restartedUpdater.loadState();
    expect(restartedUpdater.state().lastRun?.ok).toBe(true);
  });

  it("does not back up or activate a candidate that fails its scoped type checks", async () => {
    const fixture = await makeFixture();
    const baseRunner = commandRunner();
    const run: SourceUpdateCommandRunner = async (command, args, options) => {
      if (
        command === "pnpm" &&
        args[0] === "exec" &&
        args[1] === "turbo" &&
        args[2] === "run" &&
        args[3] === "check"
      ) {
        return { ok: false, exitCode: 1, stdout: "", output: "candidate type check failed" };
      }
      return baseRunner(command, args, options);
    };
    const updater = createSourceUpdater(fixture.config({ run }));
    const result = await updater.apply({
      currentCommit: fixture.localHead,
      targetCommit: fixture.upstreamHead,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isolated candidate check step failed/i);
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(fixture.localHead);
    await expect(readdir(fixture.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a merge conflict without changing the live checkout", async () => {
    const fixture = await makeFixture({ conflict: true });
    const updater = createSourceUpdater(fixture.config({ run: commandRunner() }));
    const preview = await updater.check();
    expect(preview.status, preview.reason ?? "").toBe("conflict");
    expect(preview.conflictingPaths).toContain("README.md");
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(fixture.localHead);
  });

  it("allows preserved runtime files unless upstream changes the same path", async () => {
    const allowed = await makeFixture();
    await mkdir(path.join(allowed.repo, ".state"), { recursive: true });
    await writeFile(path.join(allowed.repo, ".state/preferences.json"), "local runtime\n");
    await ignorePath(allowed.repo, ".state/");
    const allowedUpdater = createSourceUpdater(allowed.config({ run: commandRunner() }));
    const allowedPreview = await allowedUpdater.check();
    expect(allowedPreview.status, allowedPreview.reason ?? "").toBe("available");

    const conflict = await makeFixture({ upstreamPath: ".state/preferences.json" });
    await mkdir(path.join(conflict.repo, ".state"), { recursive: true });
    await writeFile(path.join(conflict.repo, ".state/preferences.json"), "local runtime\n");
    await ignorePath(conflict.repo, ".state/");
    const conflictUpdater = createSourceUpdater(conflict.config({ run: commandRunner() }));
    const preview = await conflictUpdater.check();
    expect(preview.status).toBe("conflict");
    expect(preview.conflictingPaths).toContain(".state/preferences.json");
    expect((await git(conflict.repo, ["rev-parse", "HEAD"])).trim()).toBe(conflict.localHead);
  });

  it("rechecks for edits made during the isolated candidate build", async () => {
    const fixture = await makeFixture();
    const baseRunner = commandRunner();
    let edited = false;
    const run: SourceUpdateCommandRunner = async (command, args, options) => {
      const result = await baseRunner(command, args, options);
      if (
        !edited &&
        command === "pnpm" &&
        args[0] === "exec" &&
        options.cwd.includes("rakazo-source-update-")
      ) {
        edited = true;
        await writeFile(path.join(fixture.repo, "during-build.txt"), "keep me\n");
      }
      return result;
    };
    const updater = createSourceUpdater(fixture.config({ run }));
    const result = await updater.apply({
      currentCommit: fixture.localHead,
      targetCommit: fixture.upstreamHead,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed during the candidate build/i);
    expect(await readFile(path.join(fixture.repo, "during-build.txt"), "utf8")).toBe("keep me\n");
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(fixture.localHead);
  });

  it("preserves an ignored runtime file created during the candidate build", async () => {
    const fixture = await makeFixture({ upstreamPath: ".state/preferences.json" });
    await ignorePath(fixture.repo, ".state/");
    const baseRunner = commandRunner();
    let created = false;
    const run: SourceUpdateCommandRunner = async (command, args, options) => {
      const result = await baseRunner(command, args, options);
      if (
        !created &&
        command === "pnpm" &&
        args.includes("build") &&
        options.cwd.includes("rakazo-source-update-")
      ) {
        created = true;
        await mkdir(path.join(fixture.repo, ".state"), { recursive: true });
        await writeFile(
          path.join(fixture.repo, ".state/preferences.json"),
          "keep runtime settings\n",
        );
      }
      return result;
    };
    const updater = createSourceUpdater(fixture.config({ run }));
    const result = await updater.apply({
      currentCommit: fixture.localHead,
      targetCommit: fixture.upstreamHead,
    });
    expect(created).toBe(true);
    expect(result.ok).toBe(false);
    expect(await readFile(path.join(fixture.repo, ".state/preferences.json"), "utf8")).toBe(
      "keep runtime settings\n",
    );
    expect((await git(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(fixture.localHead);
  });

  it("does not merge again after an install failure was reverted", async () => {
    const fixture = await makeFixture();
    let restarts = 0;
    const run: SourceUpdateCommandRunner = async (command, args, options) => {
      if (command === "restart" && ++restarts === 1) {
        return { ok: false, exitCode: 1, stdout: "", output: "restart failed" };
      }
      return commandRunner()(command, args, options);
    };
    const updater = createSourceUpdater(fixture.config({ run }));
    const result = await updater.apply({
      currentCommit: fixture.localHead,
      targetCommit: fixture.upstreamHead,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("rolled-back");
    expect(result.recovery).toMatch(/merge was reverted/i);
    expect(
      await git(fixture.repo, ["merge-base", "--is-ancestor", fixture.upstreamHead, "HEAD"]),
    ).toBe("");
    expect((await updater.check(fixture.upstreamHead)).status).toBe("unavailable");
    await expect(
      updater.apply({ currentCommit: result.currentCommit, targetCommit: result.targetCommit }),
    ).rejects.toThrow(/rolled back/i);
    expect(updater.state().lastRun).toEqual(result);
  });

  it.each([
    ["interrupted", true, "install", "interrupted"],
    ["recovery-failed", false, "recovery-failed", "recovery-failed"],
  ] as const)(
    "blocks a %s run until an operator recovers it",
    async (_name, running, stage, expectedStage) => {
      const fixture = await makeFixture();
      await git(fixture.repo, ["fetch", "--no-tags", "--", fixture.official, "refs/heads/main"]);
      await git(fixture.repo, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "merge",
        "--no-ff",
        "--no-edit",
        fixture.upstreamHead,
      ]);
      const currentCommit = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
      const now = new Date().toISOString();
      await writeFile(
        fixture.statePath,
        JSON.stringify({
          running,
          lastRun: {
            startedAt: now,
            finishedAt: running ? null : now,
            ok: false,
            currentCommit,
            targetCommit: fixture.upstreamHead,
            stage,
            error: "restart interrupted",
            recovery: "Inspect the source and service health before retrying.",
          },
        }),
      );
      const updater = createSourceUpdater(fixture.config({ run: commandRunner() }));
      await updater.loadState();
      expect(updater.state().lastRun?.stage).toBe(expectedStage);
      expect((await updater.check(fixture.upstreamHead)).status).toBe("unavailable");
      await expect(
        updater.apply({ currentCommit, targetCommit: fixture.upstreamHead }),
      ).rejects.toThrow(/previous update could not be confirmed/i);
      expect(updater.state().lastRun?.stage).toBe(expectedStage);
    },
  );
});

async function makeFixture(options: { conflict?: boolean; upstreamPath?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-source-update-test-"));
  roots.push(root);
  const repo = path.join(root, "checkout");
  const official = path.join(root, "official.git");
  const upstream = path.join(root, "upstream");
  const backupDir = path.join(root, "backups");
  const statePath = path.join(root, "state.json");
  const forkUrl = "https://example.invalid/fork/rakazo.git";
  await git(root, ["init", "--bare", official]);
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["remote", "add", "seed", official]);
  await git(repo, ["push", "seed", "main"]);
  await git(official, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repo, ["remote", "remove", "seed"]);
  await git(repo, ["remote", "add", "origin", forkUrl]);
  await git(root, ["clone", official, upstream]);
  await git(upstream, ["config", "user.name", "Official"]);
  await git(upstream, ["config", "user.email", "official@example.invalid"]);
  if (options.conflict) {
    await writeFile(path.join(repo, "README.md"), "custom\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "custom readme"]);
    await writeFile(path.join(upstream, "README.md"), "official\n");
  } else {
    await writeFile(path.join(repo, "local.txt"), "custom\n");
    await git(repo, ["add", "local.txt"]);
    await git(repo, ["commit", "-m", "custom local file"]);
    const upstreamPath = options.upstreamPath ?? "upstream.txt";
    await mkdir(path.dirname(path.join(upstream, upstreamPath)), { recursive: true });
    await writeFile(path.join(upstream, upstreamPath), "official\n");
  }
  const localHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const upstreamPath = options.upstreamPath ?? "upstream.txt";
  await git(upstream, ["add", "--", ...(options.conflict ? ["README.md"] : [upstreamPath])]);
  await git(upstream, ["commit", "-m", "official update"]);
  await git(upstream, ["push", "origin", "main"]);
  const upstreamHead = (await git(upstream, ["rev-parse", "HEAD"])).trim();
  return {
    repo,
    official,
    backupDir,
    statePath,
    localHead,
    upstreamHead,
    forkUrl,
    config(overrides: { run?: SourceUpdateCommandRunner } = {}) {
      return {
        deployDir: repo,
        statePath,
        backupDir,
        officialRepoUrl: official,
        branch: "main",
        ...overrides,
      };
    },
  };
}

function commandRunner(afterPnpm?: (args: string[], cwd: string) => void | Promise<void>) {
  return async (command: SourceUpdateCommand, args: string[], options: { cwd: string }) => {
    if (command === "git") {
      try {
        const result = await runFile("git", args, {
          cwd: options.cwd,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        });
        return { ok: true, exitCode: 0, stdout: result.stdout, output: result.stdout };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return {
          ok: false,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}`,
        };
      }
    }
    if (command === "pnpm") await afterPnpm?.(args, options.cwd);
    return { ok: true, exitCode: 0, stdout: "", output: "" };
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

async function ignorePath(repo: string, entry: string) {
  const exclude = path.join(repo, ".git", "info", "exclude");
  const existing = await readFile(exclude, "utf8");
  await writeFile(exclude, `${existing}${entry}\n`);
}
