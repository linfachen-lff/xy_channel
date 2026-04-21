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
  if (lower.includes("server_error")) return true;
  if (lower.includes("rate_limit_error")) return true;
  return false;
}

/** Compute retry delay in ms for the given 1-based attempt, with up to 10s jitter. */
function getRetryDelayMs(attempt: number): number {
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
 * Dynamic header keys injected via extraParams and forwarded to the HTTP request.
 * Correspond to the three fields written to .xiaoyiruntime:
 *   TASK_ID, SESSION_ID, CONVERSATION_ID
 */
const HEADER_TRACE_ID = "x-hag-trace-id";
const HEADER_SESSION_ID = "x-session-id";
const HEADER_INTERACTION_ID = "x-interaction-id";

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

    // Fallback: uid-based values
    const uid = getUidFromConfig(ctx.config);
    if (!uid) return undefined;

    const prefix = encodeUid(uid);
    const ts = Date.now();
    const fallbackValue = `${prefix}_${ts}`;

    return {
      ...ctx.extraParams,
      [HEADER_TRACE_ID]: fallbackValue,
      [HEADER_SESSION_ID]: fallbackValue,
      [HEADER_INTERACTION_ID]: fallbackValue,
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
        const traceId = ctx.extraParams[HEADER_TRACE_ID];
        const sessionId = ctx.extraParams[HEADER_SESSION_ID];
        const interactionId = ctx.extraParams[HEADER_INTERACTION_ID];

        if (typeof traceId === "string") dynamicHeaders[HEADER_TRACE_ID] = traceId;
        if (typeof sessionId === "string") dynamicHeaders[HEADER_SESSION_ID] = sessionId;
        if (typeof interactionId === "string") dynamicHeaders[HEADER_INTERACTION_ID] = interactionId;
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

      // ── Retry loop ─────────────────────────────────────────
      for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        const stream = await underlying(model, context, {
          ...options,
          headers: {
            ...options?.headers,
            ...dynamicHeaders,
          },
        });

        // Wait for the stream to settle (done or error) to inspect the result.
        // stream.result() resolves to the final AssistantMessage (even on error).
        const result = await stream.result();
        console.log("[provider] stream result:", result);

        // Check if this is a retryable error
        if (result.stopReason === "error" && isRetryableProviderError(result.errorMessage)) {
          const delayMs = getRetryDelayMs(attempt);
          console.log(
            `[xiaoyiprovider] retryable error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ` +
            `${result.errorMessage} — retrying in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue;
        }

        // Success or non-retryable error — log and return
        if (result.stopReason === "error") {
          console.log(`[xiaoyiprovider] non-retryable error: ${result.errorMessage}`);
        } else {
          console.log(
            `[xiaoyiprovider] stream completed, usage: input=${result.usage?.input} output=${result.usage?.output}`,
          );
        }

        // The original stream has already been consumed by result().
        // Build a replay stream that delivers the final result.
        return buildReplayStream(result);
      }

      // All retries exhausted — return the last attempt's real error via a new stream
      console.log(`[xiaoyiprovider] all ${MAX_RETRY_ATTEMPTS} retries exhausted, surfacing last error`);
      const lastStream = await underlying(model, context, {
        ...options,
        headers: {
          ...options?.headers,
          ...dynamicHeaders,
        },
      });
      const lastResult = await lastStream.result();
      return buildReplayStream(lastResult);
    };
  },
};
