import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument, isEmptyBotMemory } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Badge, Button, Input, SectionHeading, Skeleton, Textarea } from "@rakazo/ui-web";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AvailabilityControl,
  AvailabilityLabel,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../../components/integrations/space-availability";
import { downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import { memoryLineSelection } from "../memory-selection";

const NO_DOCS: MemoryDocument[] = [];
const NO_SKILLS: AgentSkillCatalogEntry[] = [];

const fieldClass = "mt-2 w-full font-mono text-body-sm leading-relaxed";

function rowClass(open: boolean): string {
  return `h-auto w-full justify-start whitespace-normal px-2.5 py-2.5 text-start ${open ? "bg-muted" : ""}`;
}

/**
 * Bot memory. Skills belong to the person in a space, not to one bot, so they live in
 * the Skills dialog; memory shared across bots lives in the Memory settings overlay.
 */
export function KnowledgeSection({ botId }: { botId: string }) {
  return (
    <MemoryDocumentList
      key={botId}
      input={{ botId, scope: "bot" }}
      testId="bot-knowledge-memory"
      compact
    />
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <section
      className="rounded-xl border border-border px-4 py-4"
      data-testid="space-memory-documents"
    >
      <SectionHeading variant="heading">
        <Trans>Shared memory</Trans>
      </SectionHeading>
      <p className="mt-1 text-body-sm text-muted-foreground">
        <Trans>Every bot in this space reads these notes and keeps them up to date.</Trans>
      </p>
      <div className="mt-3">
        <MemoryDocumentList input={{ scope: "user" }} testId="space-memory-list" />
      </div>
    </section>
  );
}

type MemorySelection = { start: number; end: number; expected: string };
type MemoryChange =
  | { kind: "save" | "remove" | "download"; doc: MemoryDocument }
  | {
      kind: "replace";
      doc: MemoryDocument;
      revision: number;
      selection: MemorySelection;
      replacement: string;
    }
  | { kind: "undo"; documentId: string; revision: number };

function isConflict(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "CONFLICT";
}

function MemoryDocumentList({
  input,
  testId,
  compact = false,
}: {
  input: { botId?: string; scope: "bot" | "user" };
  testId: string;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.memory.list.queryOptions({ input });
  // Bots write memory as they run, so every open refreshes behind the cached list.
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const docs = listQuery.data ?? NO_DOCS;
  const loading = listQuery.isPending;
  const budgetInput = input.scope === "bot" && input.botId ? { botId: input.botId } : null;
  const budgetOptions = budgetInput
    ? queries.memory.budget.queryOptions({ input: budgetInput })
    : null;
  const budgetQuery = useQuery(
    budgetOptions ?? { queryKey: ["memory-budget", "none"], queryFn: skipToken },
  );
  const budget = budgetInput && budgetQuery.data ? budgetQuery.data : null;
  const bytesLeftOut = budget
    ? budget.omitted.reduce((sum, entry) => sum + entry.totalBytes, 0) +
      budget.documents.reduce((sum, entry) => sum + entry.totalBytes - entry.includedBytes, 0)
    : 0;
  const kb = Math.ceil(bytesLeftOut / 1024);
  const [showAll, setShowAll] = useState(false);
  // Once shown, memory stays visible while the panel is open, even if emptied.
  const [memoryShown, setMemoryShown] = useState(false);
  const memoryVisible = memoryShown || docs.some((doc) => !isEmptyBotMemory(doc));
  if (memoryVisible && !memoryShown) setMemoryShown(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number | undefined>();
  const [conflicted, setConflicted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [selection, setSelection] = useState<MemorySelection | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ documentId: string; revision: number } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptRead = input.botId
    ? queries.memory.prompt.queryOptions({ input: { botId: input.botId } })
    : null;
  const promptQuery = useQuery(
    promptRead
      ? { ...promptRead, enabled: promptOpen }
      : { queryKey: ["memory-prompt", "none"], queryFn: skipToken },
  );
  const change = useSave({
    save: async (action: MemoryChange, rpc) => {
      if (action.kind === "undo") {
        const updated = await rpc.memory.undoEntry({
          documentId: action.documentId,
          expectedRevision: action.revision,
        });
        await setDocs((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
        return updated;
      }
      const { doc } = action;
      if (action.kind === "download") {
        const latest = (await fetchFresh(queryClient, list)).find((entry) => entry.id === doc.id);
        if (!latest) throw new Error("Document unavailable");
        downloadArtifactBytes(
          latest.path.split("/").at(-1) ?? latest.path,
          "text/markdown",
          new TextEncoder().encode(latest.content),
        );
        return undefined;
      }
      if (action.kind === "remove") {
        await rpc.memory.remove({ documentId: doc.id });
        await setDocs((current) => current.filter((entry) => entry.id !== doc.id));
        return undefined;
      }
      const updated =
        action.kind === "replace"
          ? await rpc.memory.editEntry({
              documentId: doc.id,
              expectedRevision: action.revision,
              ...action.selection,
              replacement: action.replacement,
            })
          : await rpc.memory.update({
              documentId: doc.id,
              content: draft,
              expectedRevision: loadedRevision,
            });
      await setDocs((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      return updated;
    },
    stale: (action) =>
      action.kind === "download"
        ? []
        : [list.queryKey, ...(budgetOptions ? [budgetOptions.queryKey] : [])],
    onSaved: (saved, action) => {
      if (action.kind === "replace" && saved) {
        setUndo({ documentId: saved.id, revision: saved.revision });
      } else if (action.kind === "undo") {
        setUndo(null);
      }
      if (action.kind !== "download" && action.kind !== "undo") closeDoc();
      if (action.kind !== "download") setPromptOpen(false);
    },
    onFailed: async (failure, action) => {
      if (action.kind === "undo" && isConflict(failure)) setUndo(null);
      else if ((action.kind === "save" || action.kind === "replace") && isConflict(failure))
        setConflicted(true);
      else return;
      await bestEffort("refresh memory after conflict", fetchFresh(queryClient, list));
    },
  });
  const busy = change.pending;
  const conflictedSave =
    change.error &&
    (change.input?.kind === "save" || change.input?.kind === "replace") &&
    isConflict(change.error);
  const actionError =
    change.error && !conflictedSave
      ? change.input?.kind === "undo" && isConflict(change.error)
        ? t`Document changed. Reopen to edit the latest version.`
        : change.input?.kind === "remove"
          ? t`Could not remove`
          : change.input?.kind === "save" || change.input?.kind === "replace"
            ? t`Could not save`
            : t`Could not load`
      : null;
  const error = actionError ?? (listQuery.isError ? t`Could not load` : null);

  /** What the save confirmed shows at once, even when the list cannot be read again. */
  function setDocs(update: (current: MemoryDocument[]) => MemoryDocument[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  function openDoc(doc: MemoryDocument) {
    setLoadedRevision(doc.revision);
    setConflicted(false);
    setOpenId(doc.id);
    setDraft(doc.content);
    change.reset();
    setConfirmingDelete(false);
    setSelection(null);
    setReplacement(null);
  }

  function closeDoc() {
    setOpenId(null);
    setConflicted(false);
    setConfirmingDelete(false);
    setSelection(null);
    setReplacement(null);
  }

  function remove(doc: MemoryDocument) {
    if (confirmingDelete) change.run({ kind: "remove", doc });
    else setConfirmingDelete(true);
  }

  function replaceSelection(doc: MemoryDocument) {
    if (!selection || replacement === null || loadedRevision === undefined || busy) return;
    change.run({ kind: "replace", doc, revision: loadedRevision, selection, replacement });
  }

  function undoSelection() {
    if (!undo || busy) return;
    change.run({ kind: "undo", documentId: undo.documentId, revision: undo.revision });
  }

  function viewPromptMemory() {
    setPromptOpen(true);
    if (promptQuery.isError) void promptQuery.refetch();
  }

  if (compact && !loading && !memoryVisible && !error) return null;

  return (
    <section className={compact ? "mt-6" : undefined}>
      {compact ? (
        <SectionHeading variant="label" className="mb-2">
          <Trans>Memory</Trans>
        </SectionHeading>
      ) : null}
      <div data-testid={testId} className={compact ? "rounded-xl bg-muted/50 p-4" : undefined}>
        {error ? <div className="pb-2 text-body-sm text-destructive">{error}</div> : null}
        {input.botId && memoryVisible ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || promptQuery.isFetching}
            onClick={viewPromptMemory}
          >
            <Trans>View prompt memory</Trans>
          </Button>
        ) : null}
        {promptOpen && promptQuery.isFetching ? (
          <p className="text-body-sm text-muted-foreground">
            <Trans>Loading prompt memory…</Trans>
          </p>
        ) : null}
        {promptOpen && promptQuery.isError ? (
          <p role="alert" className="text-body-sm text-destructive">
            <Trans>Could not load</Trans>
          </p>
        ) : null}
        {promptOpen && promptQuery.data ? (
          <div className="text-body-sm">
            <p className="text-muted-foreground">
              {promptQuery.data.usedBytes} / {promptQuery.data.limitBytes} <Trans>bytes</Trans>
            </p>
            <pre className="whitespace-pre-wrap break-words text-foreground">
              {promptQuery.data.text}
            </pre>
          </div>
        ) : null}
        {kb > 0 ? (
          <p className="pb-2 text-body-sm text-muted-foreground" data-testid="memory-budget-note">
            {t`About ${kb} KB of memory no longer reaches the bot.`}
          </p>
        ) : null}
        {conflicted ? (
          <div className="pb-2 text-body-sm text-destructive">
            <Trans>Document changed. Reopen to edit the latest version.</Trans>
          </div>
        ) : null}
        {undo ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={undoSelection}>
            <Trans>Undo</Trans>
          </Button>
        ) : null}
        {loading ? <Skeleton className="h-10 w-full" /> : null}
        {!compact && !loading && docs.length === 0 && !error ? (
          <div className="py-1 text-body-sm text-muted-foreground">
            <Trans>Nothing remembered yet</Trans>
          </div>
        ) : null}
        <div>
          {(compact && !showAll ? docs.slice(0, 5) : docs).map((doc) => (
            <div key={doc.id} className="border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => (openId === doc.id ? closeDoc() : openDoc(doc))}
                  className="-ms-2 h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-2.5 text-start"
                >
                  <span
                    className="min-w-0 truncate text-body font-normal text-foreground"
                    dir="auto"
                  >
                    {doc.path}
                  </span>
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-sm" />}
                    aria-label={t`Download`}
                    disabled={busy}
                    onClick={() => change.run({ kind: "download", doc })}
                  >
                    <Download className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Download</Trans>
                  </TooltipContent>
                </Tooltip>
              </div>
              {openId === doc.id ? (
                <div className="pb-2">
                  <Textarea
                    aria-label={doc.path}
                    disabled={busy}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setSelection(null);
                      setReplacement(null);
                    }}
                    onSelect={(event) => {
                      const { selectionStart, selectionEnd, value } = event.currentTarget;
                      setSelection(
                        draft === doc.content
                          ? memoryLineSelection(draft, value, selectionStart, selectionEnd)
                          : null,
                      );
                    }}
                    rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                    className={fieldClass}
                    dir="auto"
                  />
                  <div className="mt-2 flex gap-2">
                    {selection && replacement === null ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        disabled={busy || conflicted}
                        onClick={() => setReplacement(selection.expected)}
                      >
                        <Trans>Edit selection</Trans>
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={busy || conflicted || draft === doc.content}
                      onClick={() => change.run({ kind: "save", doc })}
                    >
                      <Trans>Save</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy}
                      onClick={closeDoc}
                      size="sm"
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    {isDeletableMemoryDocument(doc.path) ? (
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => remove(doc)}
                        size="sm"
                        className="ml-auto text-destructive"
                      >
                        {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
                      </Button>
                    ) : null}
                  </div>
                  {replacement !== null ? (
                    <div className="mt-2">
                      <Input
                        aria-label={t`Replacement`}
                        value={replacement}
                        onChange={(event) => setReplacement(event.target.value)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || conflicted}
                        onClick={() => replaceSelection(doc)}
                      >
                        <Trans>Replace</Trans>
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {compact && docs.length > 5 && !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SkillSourceBadge({ source }: { source: AgentSkillCatalogEntry["source"] }) {
  if (source !== "builtin" && source !== "plugin") return null;
  return (
    <Badge
      variant="secondary"
      className="rounded-full px-1.5 py-0 text-caption font-normal text-muted-foreground"
    >
      {source === "builtin" ? <Trans>Built-in</Trans> : <Trans>Plugin</Trans>}
    </Badge>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

/** Your own skills in this space, plus the built-in ones; plugin skills are listed by plugin. */
export function AgentSkills() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  // The same list the composer offers as skill mentions, so a change here shows there at once.
  const list = queries.agentSkills.list.queryOptions();
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const skills = (listQuery.data ?? NO_SKILLS).filter((skill) => skill.source !== "plugin");
  const loading = listQuery.isPending;
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? (listQuery.isError ? t`Could not load` : null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const selection = useRef(0);
  const spaceCount = useOwnSpaces().length;

  async function refresh() {
    return fetchFresh(queryClient, list);
  }

  useEffect(
    () => () => {
      selection.current += 1;
    },
    [],
  );

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t`Could not load skill`);
    }
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await rpc.agentSkills.create({ content: draft });
      } else if (open) {
        await rpc.agentSkills.update({ skillId: open.id, content: draft });
      }
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    const skillId = skill.id;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId });
      if (open?.id === skillId) {
        setOpen(null);
        setConfirmingDelete(false);
      }
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-body-sm text-destructive">{error}</div> : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-body text-muted-foreground">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <Button
              variant="ghost"
              key={entry.id}
              type="button"
              disabled={busy}
              onClick={() => void openSkill(entry)}
              className={`${rowClass(false)} -mx-2.5 w-[calc(100%+1.25rem)] block`}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0 truncate text-body font-normal text-foreground" dir="auto">
                  {entry.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <AvailabilityLabel availability={entry.availability} />
                  <SkillSourceBadge source={entry.source} />
                </span>
              </span>
              <span className="mt-0.5 block truncate text-body-sm text-muted-foreground" dir="auto">
                {entry.description}
              </span>
            </Button>
          ))
        : null}
      {editorOpen ? (
        <div className="pb-2">
          {open ? (
            <div className="flex min-h-7 items-center gap-2">
              <div className="min-w-0 truncate text-body font-normal text-foreground" dir="auto">
                {open.name}
              </div>
              <SkillSourceBadge source={open.source} />
              {open.source === "user" ? (
                <div className="ms-auto">
                  <AvailabilityControl
                    kind="skill"
                    id={open.id}
                    availability={open.availability}
                    onChanged={async () => {
                      // Another skill may have been opened while this was saving; leave it alone.
                      const opened = selection.current;
                      // Narrowed away from this space, the skill can no longer be read here.
                      const here = (await refresh()).some((entry) => entry.id === open.id);
                      if (selection.current !== opened) return;
                      if (!here) {
                        selection.current += 1;
                        setOpen(null);
                        return;
                      }
                      const fresh = await rpc.agentSkills.get({ skillId: open.id });
                      if (selection.current === opened) setOpen(fresh);
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <Textarea
            aria-label="SKILL.md"
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || !draft.trim() || (!creating && draft === open?.content)}
                onClick={() => void save()}
                className="bg-muted px-3 py-1.5 text-body-sm text-foreground disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                selection.current += 1;
                setOpen(null);
                setCreating(false);
                setConfirmingDelete(false);
              }}
              className="px-3 py-1.5 text-body-sm text-muted-foreground"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </Button>
            {open && !open.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className={`ms-auto px-3 py-1.5 text-body-sm ${
                  confirmingDelete ? "bg-destructive/10 text-destructive" : "text-destructive"
                }`}
              >
                {confirmingDelete ? (
                  reachesOtherSpaces(open.availability, spaceCount) ? (
                    <Trans>Remove from every space?</Trans>
                  ) : (
                    <Trans>Confirm delete</Trans>
                  )
                ) : (
                  <Trans>Delete</Trans>
                )}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            selection.current += 1;
            setOpen(null);
            setCreating(true);
            setConfirmingDelete(false);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          className="-mx-2.5 mt-2 h-auto min-h-11 w-[calc(100%+1.25rem)] justify-between px-2.5 py-2.5 text-body font-normal text-foreground"
        >
          <Trans>New skill</Trans>
          <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}
