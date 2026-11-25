import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  DeploymentSettingsSchema,
  ServerUpdateCheckSchema,
  ServerUpdateRequestSchema,
  ServerUpdateRunSchema,
  ServerUpdateStatusSchema,
  SourceUpdatePreviewSchema,
  SourceUpdateRunSchema,
  SourceUpdateStateSchema,
} from "./server-updates.js";

export const serverRpc = {
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  /**
   * Deployment-owner product updates. When the Compose updater sidecar is reachable, these proxy
   * to its `/state` `/plan` `/apply` contract. Rollback stays on the sidecar for ops only and is
   * not exposed here. Never git-fetch from the API process.
   */
  updater: {
    status: oc.output(ServerUpdateStatusSchema),
    check: oc.input(ServerUpdateRequestSchema).output(ServerUpdateCheckSchema),
    apply: oc.input(ServerUpdateRequestSchema).output(ServerUpdateRunSchema),
  },
  /** Owner-only safe merge from the official source repository on self-hosted checkouts. */
  sourceUpdates: {
    state: oc.output(SourceUpdateStateSchema),
    check: oc.output(SourceUpdatePreviewSchema),
    apply: oc
      .input(
        z.object({
          currentCommit: z.string().regex(/^[0-9a-f]{40}$/i),
          targetCommit: z.string().regex(/^[0-9a-f]{40}$/i),
          forkCommit: z
            .string()
            .regex(/^[0-9a-f]{40}$/i)
            .optional(),
        }),
      )
      .output(SourceUpdateRunSchema),
  },
};
