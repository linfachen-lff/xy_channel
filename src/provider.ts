// Xiaoyi Provider
// Wraps any OpenAI-compatible endpoint and injects dynamic headers
// (taskId, sessionId, conversationId) from the current XY channel session.
// Falls back to uid-based values when no session context is available.
//
// Users configure the underlying model in config:
//   models.providers.xiaoyiprovider.baseUrl = "https://..."
//   models.providers.xiaoyiprovider.api = "openai-completions"
//   models.providers.xiaoyiprovider.models = [...]
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import { getCurrentSessionContext } from "./tools/session-manager.js";

/**
 * Dynamic header keys injected via extraParams and forwarded to the HTTP request.
 * Correspond to the three fields written to .xiaoyiruntime:
 *   TASK_ID, SESSION_ID, CONVERSATION_ID
 */
const HEADER_TASK_ID = "x-task-id";
const HEADER_SESSION_ID = "x-session-id";
const HEADER_CONVERSATION_ID = "x-conversation-id";

const EXTRA_PARAM_TASK_ID = "x-task-id";
const EXTRA_PARAM_SESSION_ID = "x-session-id";
const EXTRA_PARAM_CONVERSATION_ID = "x-conversation-id";

/**
 * Encode uid to base64 and take first 32 chars.
 */
function encodeUid(uid: string): string {
  return Buffer.from(uid).toString("base64").slice(0, 32);
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

  /**
   * Inject dynamic session params into extraParams so they flow
   * through to wrapStreamFn's ctx.extraParams.
   *
   * Priority:
   *   1. Session context (from AsyncLocalStorage, set by bot.ts)
   *   2. uid-based fallback: base64(uid)[:32]_timestamp
   *   3. No uid available → return undefined (no headers injected)
   */
  prepareExtraParams: (ctx) => {
    const sessionCtx = getCurrentSessionContext();

    if (sessionCtx) {
      return {
        ...ctx.extraParams,
        [EXTRA_PARAM_TASK_ID]: sessionCtx.taskId,
        [EXTRA_PARAM_SESSION_ID]: sessionCtx.sessionId,
        [EXTRA_PARAM_CONVERSATION_ID]: sessionCtx.messageId,
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
      [EXTRA_PARAM_TASK_ID]: fallbackValue,
      [EXTRA_PARAM_SESSION_ID]: fallbackValue,
      [EXTRA_PARAM_CONVERSATION_ID]: fallbackValue,
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

    const dynamicHeaders: Record<string, string> = {};

    if (ctx.extraParams) {
      const taskId = ctx.extraParams[EXTRA_PARAM_TASK_ID];
      const sessionId = ctx.extraParams[EXTRA_PARAM_SESSION_ID];
      const conversationId = ctx.extraParams[EXTRA_PARAM_CONVERSATION_ID];

      if (typeof taskId === "string") dynamicHeaders[HEADER_TASK_ID] = taskId;
      if (typeof sessionId === "string") dynamicHeaders[HEADER_SESSION_ID] = sessionId;
      if (typeof conversationId === "string") dynamicHeaders[HEADER_CONVERSATION_ID] = conversationId;
    }

    if (Object.keys(dynamicHeaders).length === 0) return underlying;

    return async (model, context, options) => {
      // 记录输入
      console.log(`[xiaoyiprovider] input messages: ${JSON.stringify(context.messages)}`);
      if (context.systemPrompt) {
        console.log(`[xiaoyiprovider] system prompt length: ${context.systemPrompt.length}`);
      }
      console.log(`[xiaoyiprovider] headers: ${JSON.stringify(dynamicHeaders)}`);

      const stream = await underlying(model, context, {
        ...options,
        headers: {
          ...options?.headers,
          ...dynamicHeaders,
        },
      });

      // 异步监听输出（不阻塞 stream 返回）
      stream.result().then(
        (msg) => console.log(`[xiaoyiprovider] output: ${JSON.stringify(msg)}`),
        (err) => console.log(`[xiaoyiprovider] error: ${err}`),
      );

      return stream;
    };
  },
};
