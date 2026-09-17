import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787/mcp";

export function SerenitySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const tokenId = useId();
  const brainLabelId = useId();
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState("");
  const [brainLabel, setBrainLabel] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);

  async function connect() {
    if (!endpoint.trim() || !token.trim()) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        endpoint: endpoint.trim(),
        allowWrites: allowWrites ? "true" : "false",
        ...(brainLabel.trim() ? { brainLabel: brainLabel.trim() } : {}),
      },
      credentials: { token: token.trim() },
    };
    if (await onConnect(draft)) setToken("");
  }

  return (
    <>
      <Field className="mt-1">
        <FieldLabel htmlFor={endpointId}>
          <Trans>MCP endpoint</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          value={endpoint}
          disabled={busy}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder={DEFAULT_ENDPOINT}
          autoComplete="off"
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Bearer token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          placeholder="serenity…"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={brainLabelId}>
          <Trans>Brain label</Trans>
        </FieldLabel>
        <Input
          id={brainLabelId}
          value={brainLabel}
          disabled={busy}
          onChange={(event) => setBrainLabel(event.target.value)}
          placeholder="personal"
          autoComplete="off"
        />
      </Field>

      <div className="mt-4 text-[13.5px] text-muted-foreground">
        <Trans>Allow writing</Trans>
        <div className="mt-2 flex gap-2">
          <Toggle
            variant="outline"
            pressed={!allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(false)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall only</Trans>
          </Toggle>
          <Toggle
            variant="outline"
            pressed={allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(true)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall and write</Trans>
          </Toggle>
        </div>
      </div>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || token.trim().length < 8 || !endpoint.trim()}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
