-- CreateIndex
CREATE INDEX "invitation_inviterId_idx" ON "invitation"("inviterId");

-- CreateIndex
CREATE INDEX "tasks_botId_idx" ON "tasks"("botId");

-- CreateIndex
CREATE INDEX "tasks_threadId_idx" ON "tasks"("threadId");

-- CreateIndex
CREATE INDEX "runs_botId_idx" ON "runs"("botId");

-- CreateIndex
CREATE INDEX "runs_threadId_idx" ON "runs"("threadId");

-- CreateIndex
CREATE INDEX "runs_taskId_idx" ON "runs"("taskId");

-- CreateIndex
CREATE INDEX "routines_botId_idx" ON "routines"("botId");

-- CreateIndex
CREATE INDEX "memory_documents_botId_idx" ON "memory_documents"("botId");

-- CreateIndex
CREATE INDEX "artifacts_botId_idx" ON "artifacts"("botId");

-- CreateIndex
CREATE INDEX "usage_records_botId_idx" ON "usage_records"("botId");

-- CreateIndex
CREATE INDEX "usage_records_runId_idx" ON "usage_records"("runId");
