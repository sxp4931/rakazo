import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MemoryDocument } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, Text, View } from "react-native";
import { errorText } from "../lib/api/user-error";
import { memoryEntries } from "../lib/memory-entries";
import { useMobileTokens } from "../lib/native/native";
import { refreshRpcQueries, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { ProfileEditDialog } from "./bots/profile-edit-dialog";
import { NativeActionButton } from "./native/native-action-button";

type MemoryEntryChange =
  | {
      kind: "edit";
      documentId: string;
      expectedRevision: number;
      start: number;
      end: number;
      expected: string;
      replacement: string;
    }
  | { kind: "undo"; documentId: string; expectedRevision: number };

export function MemoryEntries({
  initial,
  botId,
  onClose,
  onUpdate,
}: {
  initial: MemoryDocument | null;
  botId?: string;
  onClose: () => void;
  onUpdate: (doc: MemoryDocument) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [doc, setDoc] = useState(initial);
  const [undoRevision, setUndoRevision] = useState<number | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const memoryListRead = rpcQuery(
    "memory/list",
    botId ? { botId, scope: "bot" } : { scope: "user" },
  );
  const prompt = useScreenQuery(rpcQuery("memory/prompt", { botId: botId ?? "" }), {
    enabled: showPrompt && Boolean(botId),
    onForeground: false,
  });
  const change = useSave<MemoryEntryChange, MemoryDocument>({
    save: (input, send) => {
      if (input.kind === "edit") {
        const { kind: _kind, ...body } = input;
        return send("memory/editEntry", body);
      }
      const { kind: _kind, ...body } = input;
      return send("memory/undoEntry", body);
    },
    stale: [memoryListRead.queryKey],
    onSaved: (updated, input) => {
      setDoc(updated);
      onUpdate(updated);
      setUndoRevision(input.kind === "edit" ? updated.revision : null);
      setShowPrompt(false);
    },
    onFailed: async (error) => {
      await bestEffort("refresh memory after an entry change", refreshRpcQueries("memory/list"));
      Alert.alert(t`Could not save`, errorText(error, t`Try again.`));
      onClose();
    },
  });

  useEffect(() => {
    if (prompt.error) Alert.alert(t`Could not load`, errorText(prompt.error, t`Try again.`));
  }, [prompt.error, t]);

  function replace(entry: { start: number; end: number; text: string }, replacement: string) {
    if (!doc || change.pending || replacement === entry.text) return Promise.resolve();
    change.run({
      kind: "edit",
      documentId: doc.id,
      expectedRevision: doc.revision,
      start: entry.start,
      end: entry.end,
      expected: entry.text,
      replacement,
    });
    return Promise.resolve();
  }

  function undo() {
    if (!doc || change.pending || undoRevision === null) return;
    change.run({ kind: "undo", documentId: doc.id, expectedRevision: undoRevision });
  }

  function remove(entry: { start: number; end: number; text: string }) {
    Alert.alert(t`Delete memory?`, entry.text, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Delete`, style: "destructive", onPress: () => void replace(entry, "") },
    ]);
  }

  return (
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <ScrollView
        contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: tokens.background }}
      >
        <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 20 }}>
          {doc?.path ?? t`Memory`}
        </Text>
        <NativeActionButton label={t`Close`} onPress={onClose} prominence="plain" />
        {botId ? (
          <NativeActionButton
            label={t`View prompt memory`}
            disabled={change.pending || prompt.isFetching}
            onPress={() => {
              setShowPrompt(true);
              if (prompt.isError) void prompt.refetch();
            }}
            prominence="plain"
          />
        ) : null}
        {prompt.data ? (
          <>
            <Text style={{ color: tokens.mutedForeground }}>
              {t`${ph({ used: prompt.data.usedBytes })} / ${ph({ limit: prompt.data.limitBytes })} bytes`}
            </Text>
            <Text selectable style={{ color: tokens.foreground }}>
              {prompt.data.text}
            </Text>
          </>
        ) : null}
        {undoRevision !== null ? (
          <NativeActionButton
            label={t`Undo`}
            disabled={change.pending}
            onPress={undo}
            prominence="plain"
          />
        ) : null}
        {memoryEntries(doc?.content ?? "").map((entry) => (
          <View key={entry.start} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <ProfileEditDialog
                value={entry.text}
                label={t`Edit memory`}
                editLabel={t`Edit ${ph({ entry: entry.text })}`}
                maxLength={100000}
                preserveWhitespace
                onCommit={(next) => (next ? replace(entry, next) : Promise.resolve(remove(entry)))}
              />
            </View>
            <NativeActionButton
              label={t`Delete`}
              accessibilityLabel={t`Delete ${ph({ entry: entry.text })}`}
              disabled={change.pending}
              prominence="plain"
              onPress={() => remove(entry)}
            />
          </View>
        ))}
      </ScrollView>
    </Modal>
  );
}
