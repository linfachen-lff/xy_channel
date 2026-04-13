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
 * Get uid from plugin config (OpenClawConfig -> plugins -> xiaoyi-channel -> config).
 */
function getUidFromConfig(config: any): string | undefined {
  return config?.plugins?.entries?.["xiaoyi-channel"]?.config?.uid;
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
   * HTTP request to the model provider.
   *
   * Reads the values injected by prepareExtraParams and adds them
   * as HTTP headers on the outgoing request.
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

      // 在发送给模型前，删除 systemPrompt 中 ## Tooling 与 TOOLS.md 声明之间的内容
      if (context.systemPrompt) {
        const before = context.systemPrompt.length;
        context.systemPrompt = context.systemPrompt.replace(
          /(## Tooling)[\s\S]*?(TOOLS\.md does not control tool availability; it is user guidance for how to use external tools\.)/,
          "$1\n\n$2",
        );
        console.log(`[xiaoyiprovider] system prompt trimmed: ${before} -> ${context.systemPrompt.length}`);
      }

      const stream = await underlying(model, context, {
        ...options,
        headers: {
          ...options?.headers,
          ...dynamicHeaders,
        },
      });

      // 异步监听输出（不阻塞 stream 返回）
      stream.result().then(
        (result) => {
          console.log(`[xiaoyiprovider] stream completed, usage: input=${result.usage?.input} output=${result.usage?.output}`);
        },
        (err) => console.log(`[xiaoyiprovider] stream error: ${err}`),
      );

      // 用 Proxy 拦截 result()，检查 usage 是否为全零（表示上下文超长）
      return new Proxy(stream, {
        get(target, prop, receiver) {
          if (prop === "result") {
            const originalResult = target.result.bind(target);
            return () => originalResult().then((result: any) => {
              if (result?.usage?.input === 0 && result?.usage?.output === 0) {
                const error: any = new Error(
                  "This model's maximum context length was exceeded.",
                );
                error.type = "invalid_request_error";
                error.code = "context_length_exceeded";
                error.param = "messages";
                throw error;
              }
              return result;
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    };
  },
};
