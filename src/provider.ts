// Xiaoyi Provider
// Wraps any OpenAI-compatible endpoint and injects dynamic headers
// (taskId, sessionId, conversationId) from the current XY channel session.
// Falls back to uid-based values when no session context is available.
//
// Users configure the underlying model in config:
//   models.providers.xiaoyiprovider.baseUrl = "https://..."
//   models.providers.xiaoyiprovider.api = "openai-completions"
//   models.providers.xiaoyiprovider.models = [...]
import { createHash } from "crypto";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import { getCurrentSessionContext } from "./tools/session-manager.js";

// ── Retry config ──────────────────────────────────────────────
const RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 60_000];
const MAX_RETRY_ATTEMPTS = 8;

/** Check if an errorMessage indicates a retryable provider error by type. */
function isRetryableProviderError(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (lower.includes("the server had an error while processing your request")) return true;
  if (lower.includes("rate limit reached for requests")) return true;
  return false;
}

/** Check if the request is triggered by a cron job by inspecting the first user message. */
function isCronTriggered(messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }> | undefined): boolean {
  if (!messages) return false;
  const firstUser = messages.find(m => m.role === "user");
  if (!firstUser) return false;
  let text = "";
  if (typeof firstUser.content === "string") {
    text = firstUser.content;
  } else if (Array.isArray(firstUser.content)) {
    const block = firstUser.content.find(b => b.type === "text" && typeof b.text === "string");
    if (block) text = block.text;
  }
  return /^\[cron:/i.test(text.trim());
}

/** Compute retry delay in ms for the given 1-based attempt, with up to 10s jitter. */
function getRetryDelayMs(attempt: number, isCron = false): number {
  if (isCron) {
    return 60_000 + Math.floor(Math.random() * 10_000);
  }
  const base = attempt <= RETRY_DELAYS_MS.length
    ? RETRY_DELAYS_MS[attempt - 1]
    : RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const jitter = Math.floor(Math.random() * 10_000);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal EventStream-compatible object that replays a single
 * done/error event. This avoids importing @mariozechner/pi-ai at runtime
 * (the package is not available in the extension sandbox).
 */
function buildReplayStream(result: any): any {
  let settled = false;
  const queued: any[] = [
    result.stopReason === "error"
      ? { type: "error", reason: "error", error: result }
      : { type: "done", reason: result.stopReason, message: result },
  ];

  return {
    result: () => Promise.resolve(result),
    push: () => {},
    end: () => {},
    [Symbol.asyncIterator]: () => {
      return {
        next: async () => {
          if (settled || queued.length === 0) {
            settled = true;
            return { value: undefined, done: true };
          }
          settled = true;
          return { value: queued.shift(), done: false };
        },
      };
    },
  };
}

/**
 * Wrap the underlying stream with retry logic while preserving real-time streaming.
 *
 * Strategy:
 *  1. Buffer events until the first content-bearing event is seen.
 *  2. If the stream errors before any content, the buffer is tiny (start + error)
 *     and we can safely retry with a fresh API call.
 *  3. Once content events appear, flush the buffer and switch to pass-through mode
 *     — the consumer sees every text_delta in real time.
 */
function createRetryingStream(
  createStream: () => any,
  cronJob: boolean,
): any {
  let resultResolve: (value: any) => void;
  const resultPromise = new Promise<any>(resolve => { resultResolve = resolve; });

  const CONTENT_EVENT_TYPES = new Set([
    "text_start", "text_delta", "text_end",
    "thinking_start", "thinking_delta", "thinking_end",
    "toolcall_start", "toolcall_delta", "toolcall_end",
  ]);

  async function* retryGenerator() {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const stream = await createStream();
      let hasContent = false;
      const buffer: any[] = [];
      let errorResult: any = null;

      for await (const event of stream) {
        const isContent = CONTENT_EVENT_TYPES.has(event.type);

        if (!hasContent && !isContent) {
          // ── Buffer phase (no content yet) ──
          if (event.type === "done") {
            console.log(
              `[xiaoyiprovider] stream completed (no content), usage: input=${event.message?.usage?.input} output=${event.message?.usage?.output}`,
            );
            for (const b of buffer) yield b;
            resultResolve(event.message);
            yield event;
            return;
          }
          if (event.type === "error") {
            errorResult = event.error;
          }
          buffer.push(event);
        } else {
          // ── Streaming phase ──
          if (!hasContent) {
            console.log("[xiaoyiprovider] first content event received, switching to streaming mode");
            hasContent = true;
            for (const b of buffer) yield b;
          }
          // IMPORTANT: resolve result() BEFORE yielding terminal events to avoid deadlock.
          // The SDK calls result() when it sees done/error — if we yield first, the generator
          // suspends and can never reach resolve, causing a permanent deadlock.
          if (event.type === "done") {
            console.log(
              `[xiaoyiprovider] stream completed, usage: input=${event.message?.usage?.input} output=${event.message?.usage?.output}`,
            );
            resultResolve(event.message);
            yield event;
            return;
          }
          if (event.type === "error") {
            console.log(`[xiaoyiprovider] stream error after content: ${event.error?.errorMessage}`);
            resultResolve(event.error);
            yield event;
            return;
          }
          yield event;
        }
      }

      // Stream ended during buffer phase — decide whether to retry
      if (errorResult?.stopReason === "error" && isRetryableProviderError(errorResult.errorMessage)) {
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          const delayMs = getRetryDelayMs(attempt + 1, cronJob);
          console.log(
            `[xiaoyiprovider] retryable error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ` +
            `${errorResult.errorMessage} — retrying in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue; // discard buffer, retry with a new stream
        }
        console.log(`[xiaoyiprovider] all ${MAX_RETRY_ATTEMPTS} retries exhausted, surfacing last error`);
      } else if (errorResult) {
        console.log(`[xiaoyiprovider] non-retryable error: ${errorResult.errorMessage}`);
      }

      // Non-retryable or retries exhausted — yield buffered events.
      // Resolve before yielding the terminal event to avoid the same deadlock.
      for (const b of buffer) {
        if (b.type === "done") {
          resultResolve(b.message);
        } else if (b.type === "error") {
          resultResolve(b.error);
        }
        yield b;
      }
      if (errorResult && buffer.every(b => b.type !== "done" && b.type !== "error")) {
        resultResolve(errorResult);
      }
      return;
    }

    // Safety: final fallback attempt
    console.log("[xiaoyiprovider] entering final fallback attempt");
    const lastStream = await createStream();
    for await (const event of lastStream) {
      if (event.type === "done") {
        resultResolve(event.message);
        yield event;
        return;
      }
      if (event.type === "error") {
        resultResolve(event.error);
        yield event;
        return;
      }
      yield event;
    }
  }

  const gen = retryGenerator();
  return {
    result: () => resultPromise,
    push: () => {},
    end: () => {},
    [Symbol.asyncIterator]: () => gen,
  };
}

/**
 * Dynamic header keys injected via extraParams and forwarded to the HTTP request.
 * Correspond to the three fields written to .xiaoyiruntime:
 *   TASK_ID, SESSION_ID, CONVERSATION_ID
 */
const HEADER_TRACE_ID = "x-hag-trace-id";
const HEADER_SESSION_ID = "x-session-id";
const HEADER_INTERACTION_ID = "x-interaction-id";
/** Internal key for passing fallback uid prefix from prepareExtraParams to wrapStreamFn. */
const FALLBACK_PREFIX_KEY = "_xiaoyi_fallback_prefix";

/**
 * Encode uid via SHA-256 and take first 32 hex chars.
 */
function encodeUid(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 32);
}

/**
 * Get uid from channel config (OpenClawConfig -> channels -> xiaoyi-channel -> uid).
 */
function getUidFromConfig(config: any): string | undefined {
  return config?.channels?.["xiaoyi-channel"]?.uid;
}

export const xiaoyiProvider: ProviderPlugin = {
  id: "xiaoyiprovider",
  label: "Xiaoyi Provider",
  docsPath: "/providers/models",
  auth: [],
  isCacheTtlEligible: () => true,

  /**
   * Inject dynamic session params into extraParams so they flow
   * through to wrapStreamFn's ctx.extraParams.
   *
   * Priority:
   *   1. Session context (from AsyncLocalStorage, set by bot.ts)
   *   2. uid-based fallback: sha256(uid).hex[:32]_timestamp
   *   3. No uid available → return undefined (no headers injected)
   */
  prepareExtraParams: (ctx) => {
    const sessionCtx = getCurrentSessionContext();

    if (sessionCtx) {
      const taskId = sessionCtx.taskId;
      const sessionId = taskId.split("&")[0];
      const interactionId = taskId.split("&")[1] || "";
      return {
        ...ctx.extraParams,
        [HEADER_TRACE_ID]: taskId,
        [HEADER_SESSION_ID]: sessionId,
        [HEADER_INTERACTION_ID]: interactionId,
      };
    }

    // Fallback: store uid prefix for lazy timestamp generation in wrapStreamFn.
    // This ensures each model call gets a fresh timestamp instead of reusing
    // the same one across tool-use loops and retries.
    const uid = getUidFromConfig(ctx.config);
    if (!uid) return undefined;

    return {
      ...ctx.extraParams,
      [FALLBACK_PREFIX_KEY]: encodeUid(uid),
    };
  },

  /**
   * Wrap the stream function to inject dynamic headers into every
   * HTTP request to the model provider, and retry on retryable errors
   * (server_error / rate_limit_error) with backoff: 10s, 20s, 40s, 60s (cap).
   *
   * The retry loop awaits stream.result() to detect errors before deciding
   * whether to retry. This keeps the agent loop waiting (no timeout risk
   * since the default agent timeout is 48 hours).
   */
  wrapStreamFn: (ctx) => {
    const underlying = ctx.streamFn;
    if (!underlying) return underlying;

    return async (model, context, options) => {
      // 每次请求时从 ctx.extraParams 动态读取 header
      const dynamicHeaders: Record<string, string> = {};

      if (ctx.extraParams) {
        const fallbackPrefix = ctx.extraParams[FALLBACK_PREFIX_KEY];

        if (typeof fallbackPrefix === "string") {
          // Fallback mode: generate fresh timestamp per request
          const isCron = isCronTriggered(context.messages);
          const fallbackValue = `${fallbackPrefix}_${Date.now()}`;
          dynamicHeaders[HEADER_TRACE_ID] = isCron ? `cron_${fallbackValue}` : fallbackValue;
          dynamicHeaders[HEADER_SESSION_ID] = fallbackValue;
          dynamicHeaders[HEADER_INTERACTION_ID] = fallbackValue;
        } else {
          // Session mode: use pre-resolved session headers
          const traceId = ctx.extraParams[HEADER_TRACE_ID];
          const sessionId = ctx.extraParams[HEADER_SESSION_ID];
          const interactionId = ctx.extraParams[HEADER_INTERACTION_ID];

          if (typeof traceId === "string") {
            const isCron = isCronTriggered(context.messages);
            dynamicHeaders[HEADER_TRACE_ID] = isCron ? `cron_${traceId}` : traceId;
          }
          if (typeof sessionId === "string") dynamicHeaders[HEADER_SESSION_ID] = sessionId;
          if (typeof interactionId === "string") dynamicHeaders[HEADER_INTERACTION_ID] = interactionId;
        }
      }

      // 记录输入
      console.log(`[xiaoyiprovider] input messages count: ${context.messages?.length ?? 0}`);
      if (context.systemPrompt) {
        console.log(`[xiaoyiprovider] system prompt length: ${context.systemPrompt.length}`);
      }

      // 在发送给模型前，优化 systemPrompt 结构
      if (context.systemPrompt) {
        let sp = context.systemPrompt;
        const beforeLen = sp.length;

        // 删除 ## Tooling 与 TOOLS.md 声明之间的内容
        sp = sp.replace(
          /(## Tooling)[\s\S]*?(TOOLS\.md does not control tool availability; it is user guidance for how to use external tools\.)/,
          "$1\n\n$2",
        );

        // (1) 提取 ## Skills (mandatory) 到 </available_skills> 作为第一部分
        const skillsMatch = sp.match(/(## Skills \(mandatory\)[\s\S]*?<\/available_skills>)/);
        const part1 = skillsMatch ? skillsMatch[0] : '';

        // (2) 提取 ## /home/sandbox/.openclaw/workspace/SOUL.md 到 ## /home/sandbox/.openclaw/workspace/TOOLS.md 之前的内容作为第二部分
        const soulMatch = sp.match(/(## \/home\/sandbox\/\.openclaw\/workspace\/SOUL\.md[\s\S]*?)(?=## \/home\/sandbox\/\.openclaw\/workspace\/TOOLS\.md)/);
        const part2 = soulMatch ? soulMatch[1].trim() : '';

        if (part1 || part2) {
          // 从原始位置删除已提取的部分
          if (skillsMatch) sp = sp.replace(skillsMatch[0], '');
          if (soulMatch) sp = sp.replace(soulMatch[1], '');
          // 清理多余空行
          sp = sp.replace(/\n{3,}/g, '\n\n');

          // (3) 将 第二部分 + 第一部分 插入到 ## Runtime 上面
          const combined = (part2 + '\n\n' + part1).trim();
          if (combined && sp.includes('## Runtime')) {
            sp = sp.replace('## Runtime', combined + '\n\n## Runtime');
          }
        }

        console.log(`[xiaoyiprovider] system prompt optimized: ${beforeLen} -> ${sp.length}`);
        context.systemPrompt = sp;
      }

      // Append device context to systemPrompt
      const sessionCtx = getCurrentSessionContext();
      if (sessionCtx?.deviceType) {
        const rawDevice = sessionCtx.deviceType;
        const displayDevice = (rawDevice === "2in1") ? "鸿蒙PC" : rawDevice;
        const deviceSection = `\n\n## Current User Device Context\nThe current user is using the following device: ${displayDevice}\nYou need to be aware of the user's current device and provide guidance accordingly. If the response involves device-related tools or actions, you must tailor the reply based on the user's current device, using device-specific references such as "saved to the Notes/Calendar on your {deviceType}.\n"`;
        context.systemPrompt = (context.systemPrompt ?? "") + deviceSection;
      }

      // ── Retry-capable streaming ──────────────────────────────
      const cronJob = isCronTriggered(context.messages);
      if (cronJob) console.log("[xiaoyiprovider] detected cron-triggered request, using extended retry delays");

      const makeStream = () => underlying(model, context, {
        ...options,
        headers: {
          ...options?.headers,
          ...dynamicHeaders,
        },
      });

      return createRetryingStream(makeStream, cronJob);
    };
  },
};
