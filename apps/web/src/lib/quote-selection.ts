import type { ThreadMessage } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";

function truncateQuote(value: string): string {
  const truncated = value.slice(0, REPLY_QUOTE_MAX_LENGTH);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

/**
 * Resolves a text selection to the message it quotes. A quote stays scoped to
 * one Markdown text region; selections that cross regions or include message
 * chrome and structured cards get no affordance. The excerpt is capped at
 * capture so an oversized selection never fails the send.
 */
export function quoteDraftForSelection(
  selection: {
    startContent: Pick<HTMLElement, "dataset"> | null;
    endContent: Pick<HTMLElement, "dataset"> | null;
    text: string;
  },
  messageById: ReadonlyMap<string, ThreadMessage>,
): { message: ThreadMessage; text: string } | null {
  const { startContent, endContent } = selection;
  const message =
    startContent && startContent === endContent
      ? messageById.get(startContent.dataset.quoteMessageId ?? "")
      : undefined;
  const text = truncateQuote(selection.text.trim());
  if (!message || !text) return null;
  return { message, text };
}
