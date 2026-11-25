import * as z from "zod";
import { Id } from "../ids.js";

export const DeploymentSettingsSchema = z.object({
  ownerUserId: Id.nullable(),
  signupsEnabled: z.boolean(),
  signupAllowlist: z.array(z.string()),
  hasDeploymentModelCredential: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
  sandboxProvider: z.string(),
});

export const ServerUpdateSourceSchema = z.object({
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  official: z.boolean(),
});

export const ServerUpdateStepSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(8_001),
});

/** How an update reaches new code: published images, a build on the server, or a git checkout. */
export const ServerUpdateStrategySchema = z.enum(["pull", "build", "checkout"]);

/** `sidecar` is the Compose deployment; `checkout` is a supervised source install. */
export const ServerUpdateModeSchema = z.enum(["sidecar", "checkout", "unavailable"]);

/**
 * What Settings should render for a deployment owner.
 * `sidecar`: Check / Update / Rollback through the updater sidecar.
 * `compose`: Compose install without a reachable sidecar; show host pull/up commands.
 * `source`: git checkout / `pnpm dev`; show terminal commands, never a fake Apply.
 */
export const ServerUpdateInstallKindSchema = z.enum(["sidecar", "compose", "source"]);

export const ServerUpdateRunSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  ok: z.boolean(),
  fromCommit: z.string().nullable(),
  toCommit: z.string().nullable(),
  fromTag: z.string().nullable(),
  toTag: z.string().nullable(),
  strategy: ServerUpdateStrategySchema.nullable(),
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  /**
   * `recreated` means the updater sidecar replaced the containers and no restart is owed.
   * `supervised` means the process exited and its supervisor is bringing it back.
   */
  restart: z.enum(["recreated", "supervised", "manual", "not-required"]),
  restartAdvice: z.string(),
  error: z.string().nullable(),
  steps: z.array(ServerUpdateStepSchema),
});
export type ServerUpdateRun = z.infer<typeof ServerUpdateRunSchema>;

export const ServerUpdateStatusSchema = z.object({
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  installKind: ServerUpdateInstallKindSchema,
  /** Host commands to run when `installKind` is not `sidecar`. Empty when the sidecar applies. */
  manualCommands: z.array(z.string()),
  mode: ServerUpdateModeSchema,
  strategy: ServerUpdateStrategySchema.nullable(),
  strategyNote: z.string().nullable(),
  version: z.string(),
  revision: z.string().nullable(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  dirty: z.boolean(),
  dirtyPaths: z.array(z.string()),
  image: z.string().nullable(),
  imageTag: z.string().nullable(),
  previousImageTag: z.string().nullable(),
  canRollback: z.boolean(),
  source: ServerUpdateSourceSchema,
  officialRepoUrl: z.string(),
  restartSupervisor: z.enum(["systemd", "pm2", "declared", "none"]),
  restartAdvice: z.string(),
  running: z.boolean(),
  lastRun: ServerUpdateRunSchema.nullable(),
});

export const ServerUpdateCheckSchema = z.object({
  status: z.enum(["unavailable", "dirty", "up-to-date", "available"]),
  reason: z.string().nullable(),
  changed: z.array(z.string()),
  commit: z.string().nullable(),
  targetCommit: z.string().nullable(),
  targetTag: z.string().nullable(),
  behindBy: z.number().int().nonnegative(),
});

export const ServerUpdateRequestSchema = z.object({
  repoUrl: z.string().max(400).optional(),
  branch: z.string().max(200).optional(),
});

/** A commit from the official upstream branch included in a reviewed source update. */
export const SourceUpdateCommitSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/i),
  subject: z.string().max(300),
});
export type SourceUpdateCommit = z.infer<typeof SourceUpdateCommitSchema>;

export const SourceUpdatePreviewSchema = z.object({
  status: z.enum(["unavailable", "dirty", "up-to-date", "available", "conflict", "running"]),
  reason: z.string().max(500).nullable(),
  currentCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .nullable(),
  targetCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .nullable(),
  branch: z.string().max(200).nullable(),
  forkCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  changedPaths: z.array(z.string().max(500)).max(300),
  conflictingPaths: z.array(z.string().max(500)).max(300),
  commits: z.array(SourceUpdateCommitSchema).max(100),
  commitCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string().max(500)).max(300),
  fileCount: z.number().int().nonnegative(),
  summary: z.string().max(2_000).nullable(),
  summaryAvailable: z.boolean(),
});
export type SourceUpdatePreview = z.infer<typeof SourceUpdatePreviewSchema>;

export const SourceUpdateRunSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  ok: z.boolean(),
  currentCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  targetCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  forkCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  stage: z.string().max(80),
  error: z.string().max(500).nullable(),
  recovery: z.string().max(500).nullable(),
});
export type SourceUpdateRun = z.infer<typeof SourceUpdateRunSchema>;

export const SourceUpdateStateSchema = z.object({
  running: z.boolean(),
  lastRun: SourceUpdateRunSchema.nullable(),
});
export type SourceUpdateState = z.infer<typeof SourceUpdateStateSchema>;
