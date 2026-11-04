-- Applied after upstream table and index migrations.
-- CreateIndex
CREATE INDEX IF NOT EXISTS "invitation_inviterId_idx" ON "invitation"("inviterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_botId_idx" ON "tasks"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_threadId_idx" ON "tasks"("threadId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "routines_botId_idx" ON "routines"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memory_documents_botId_idx" ON "memory_documents"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "artifacts_botId_idx" ON "artifacts"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_records_botId_idx" ON "usage_records"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_records_runId_idx" ON "usage_records"("runId");
