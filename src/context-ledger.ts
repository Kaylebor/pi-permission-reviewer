/**
 * A provider-neutral, deliberately lossy view of Pi's agent transcript.
 *
 * The permission reviewer must not receive Pi's system prompt, images,
 * provider diagnostics, or arbitrary message details.  This ledger accepts
 * the public `context` and `message_end` payloads as unknown values so the
 * extension stays compatible with Pi's custom AgentMessage union.
 */

export type ReviewContextMode = "transcript" | "metadata";

export interface ReviewContextOptions {
  mode?: ReviewContextMode;
  /** Approximate token budget for conversation entries. */
  conversationTokens?: number;
  /** Approximate token budget for commands, tool calls, and tool output. */
  toolTokens?: number;
}

export interface ReviewEvidenceEntry {
  role: "user" | "assistant" | "tool" | "bash" | "summary" | "custom";
  text: string;
  timestamp?: number;
  toolName?: string;
  isError?: boolean;
}

export interface ReviewContextMetadata {
  observedMessages: number;
  representedConversationMessages: number;
  representedToolMessages: number;
  omittedConversationMessages: number;
  omittedToolMessages: number;
  conversationTokens: number;
  toolTokens: number;
}

export interface ReviewContextEvidence {
  mode: ReviewContextMode;
  metadata: ReviewContextMetadata;
  /** Present only when the configured mode is `transcript`. */
  conversation?: ReviewEvidenceEntry[];
  /** Present only when the configured mode is `transcript`. */
  tools?: ReviewEvidenceEntry[];
}

const DEFAULT_CONVERSATION_TOKENS = 4_000;
const DEFAULT_TOOL_TOKENS = 2_000;
const REDACTED = "[REDACTED]";
const OMITTED_IMAGE = "[image omitted]";
const MAX_EVIDENCE_ENTRIES = 80;
const ENTRY_OVERHEAD_TOKENS = 4;

/**
 * Captures the latest context snapshot and finalized message deltas.  Pi
 * replaces a context array during compaction and branch changes, so snapshots
 * are authoritative rather than additive.
 */
export class ContextLedger {
  #messages: unknown[] = [];
  #finalized = new WeakSet<object>();

  captureContext(messages: readonly unknown[]): void {
    this.#messages = [...messages];
    this.#finalized = new WeakSet(
      messages.filter(isObject),
    );
  }

  captureMessageEnd(message: unknown): void {
    if (isObject(message)) {
      if (this.#finalized.has(message)) return;
      this.#finalized.add(message);
    }

    const last = this.#messages.at(-1);
    if (sameFinalizedMessage(last, message)) return;
    this.#messages.push(message);
  }

  clear(): void {
    this.#messages = [];
    this.#finalized = new WeakSet();
  }

  buildEvidence(options: ReviewContextOptions = {}): ReviewContextEvidence {
    const mode = options.mode ?? "transcript";
    const conversationBudget = normalizeBudget(
      options.conversationTokens,
      DEFAULT_CONVERSATION_TOKENS,
    );
    const toolBudget = normalizeBudget(options.toolTokens, DEFAULT_TOOL_TOKENS);
    const entries = this.#messages.flatMap(toEvidenceEntry);
    const conversation = entries.filter((entry) => !isToolEntry(entry));
    const tools = entries.filter(isToolEntry);
    const selectedConversation = selectEntries(conversation, conversationBudget);
    const selectedTools = selectEntries(tools, toolBudget);
    const metadata: ReviewContextMetadata = {
      observedMessages: this.#messages.length,
      representedConversationMessages: selectedConversation.length,
      representedToolMessages: selectedTools.length,
      omittedConversationMessages: conversation.length - selectedConversation.length,
      omittedToolMessages: tools.length - selectedTools.length,
      conversationTokens: estimateEntriesTokens(selectedConversation),
      toolTokens: estimateEntriesTokens(selectedTools),
    };

    return freezeEvidence(mode === "metadata"
      ? { mode, metadata }
      : { mode, metadata, conversation: selectedConversation, tools: selectedTools });
  }
}

function freezeEvidence(evidence: ReviewContextEvidence): ReviewContextEvidence {
  if (evidence.conversation) {
    for (const item of evidence.conversation) Object.freeze(item);
    Object.freeze(evidence.conversation);
  }
  if (evidence.tools) {
    for (const item of evidence.tools) Object.freeze(item);
    Object.freeze(evidence.tools);
  }
  Object.freeze(evidence.metadata);
  return Object.freeze(evidence);
}

/**
 * Render evidence as JSON so it remains data rather than an additional
 * instruction channel in the review prompt.
 */
export function formatReviewEvidence(evidence: ReviewContextEvidence): string {
  return JSON.stringify(evidence);
}

function toEvidenceEntry(message: unknown): ReviewEvidenceEntry[] {
  if (!isObject(message) || typeof message.role !== "string") return [];
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

  switch (message.role) {
    case "user":
      return [entry("user", contentToText(message.content), timestamp)];
    case "assistant": {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .flatMap((part) => {
          if (!isObject(part)) return [];
          if (part.type === "text" && typeof part.text === "string") {
            return [redactText(part.text)];
          }
          // Thinking, images, opaque signatures, diagnostics, and provider metadata
          // are intentionally absent from reviewer evidence.
          return [];
        })
        .filter(Boolean)
        .join("\n");
      const toolCalls = content.flatMap((part) => {
        if (!isObject(part) || part.type !== "toolCall") return [];
        const toolName = typeof part.name === "string" ? part.name : "unknown";
        return [
          {
            ...entry("tool", `tool call: ${safeJson(part.arguments)}`, timestamp),
            toolName,
          },
        ];
      });
      return [...(text ? [entry("assistant", text, timestamp)] : []), ...toolCalls];
    }
    case "toolResult":
      return [
        {
          ...entry("tool", contentToText(message.content), timestamp),
          toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
          isError: message.isError === true,
        },
      ];
    case "bashExecution":
      return [
        {
          ...entry(
            "bash",
            `command: ${redactText(String(message.command ?? ""))}\noutput: ${redactText(String(message.output ?? ""))}`,
            timestamp,
          ),
          isError: typeof message.exitCode === "number" && message.exitCode !== 0,
        },
      ];
    case "branchSummary":
    case "compactionSummary":
      return [entry("summary", redactText(String(message.summary ?? "")), timestamp)];
    case "custom":
      return [entry("custom", contentToText(message.content), timestamp)];
    default:
      return [];
  }
}

function entry(
  role: ReviewEvidenceEntry["role"],
  text: string,
  timestamp: number | undefined,
): ReviewEvidenceEntry {
  return { role, text: redactText(text), ...(timestamp === undefined ? {} : { timestamp }) };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return redactText(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isObject(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "image") return [OMITTED_IMAGE];
      return [];
    })
    .map(redactText)
    .join("\n");
}

function selectEntries(
  entries: ReviewEvidenceEntry[],
  budget: number,
): ReviewEvidenceEntry[] {
  if (budget <= 0 || entries.length === 0) return [];
  const selected = new Set<number>();
  let remaining = budget;

  // Keep the original user intent if possible, then favor the most recent
  // evidence. This preserves authorization context through long tool runs.
  const firstUser = entries.findIndex((entry) => entry.role === "user");
  if (firstUser >= 0) {
    const cost = estimateTokens(entries[firstUser].text);
    if (cost <= remaining && selected.size < MAX_EVIDENCE_ENTRIES) {
      selected.add(firstUser);
      remaining -= cost;
    }
  }
  for (let index = entries.length - 1; index >= 0 && remaining > 0 && selected.size < MAX_EVIDENCE_ENTRIES; index -= 1) {
    if (selected.has(index)) continue;
    const cost = estimateTokens(entries[index].text);
    if (cost <= remaining) {
      selected.add(index);
      remaining -= cost;
      continue;
    }
    if (remaining >= ENTRY_OVERHEAD_TOKENS + 8) {
      entries[index] = { ...entries[index], text: truncateToTokens(entries[index].text, remaining) };
      selected.add(index);
      remaining = 0;
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => entries[index]);
}

function truncateToTokens(text: string, tokens: number): string {
  const contentTokens = Math.max(1, tokens - ENTRY_OVERHEAD_TOKENS);
  const characters = Math.max(1, contentTokens * 4 - 14);
  return text.length <= characters ? text : `${text.slice(0, characters)} [truncated]`;
}

function estimateEntriesTokens(entries: readonly ReviewEvidenceEntry[]): number {
  return entries.reduce((total, entry) => total + estimateTokens(entry.text), 0);
}

function estimateTokens(text: string): number {
  return ENTRY_OVERHEAD_TOKENS + Math.ceil(text.length / 4);
}

function isToolEntry(entry: ReviewEvidenceEntry): boolean {
  return entry.role === "tool" || entry.role === "bash";
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function redactText(value: string): string {
  const parsed = parseJsonValue(value);
  const text = parsed === undefined ? value : JSON.stringify(redactValue(parsed));
  return text
    .replace(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|credential|private[_-]?key|cookie|session[_-]?token|token)\b(\s*[:=]\s*)((?!Bearer\b)[^\s,;]+)/gi, `$1$2${REDACTED}`);
}

function parseJsonValue(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return;
  }
}

function safeJson(value: unknown): string {
  try {
    return redactText(JSON.stringify(redactValue(value)));
  } catch {
    return "[unserializable arguments]";
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isObject(value)) return typeof value === "string" ? redactText(value) : value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(child),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|credential|private[_-]?key|cookie|session[_-]?token)/i.test(key);
}

function sameFinalizedMessage(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isObject(left) || !isObject(right)) return false;
  return left.role === right.role && left.timestamp === right.timestamp;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
