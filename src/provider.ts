// Xiaoyi OpenAI-compatible provider
// Wraps any OpenAI-compatible endpoint and injects dynamic headers
// (taskId, sessionId, messageId) from the current XY channel session.
//
// Users configure the underlying model in config:
//   models.providers.xiaoyi-openai.baseUrl = "https://..."
//   models.providers.xiaoyi-openai.api = "openai-completions"
//   models.providers.xiaoyi-openai.models = [...]
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import { getCurrentSessionContext } from "./tools/session-manager.js";

/**
 * Dynamic header keys injected via extraParams and forwarded to the HTTP request.
 * Replace these with the actual field names required by your backend.
 */
const HEADER_TASK_ID = "X-Xiaoyi-Task-Id";
const HEADER_SESSION_ID = "X-Xiaoyi-Session-Id";
const HEADER_MESSAGE_ID = "X-Xiaoyi-Message-Id";

const EXTRA_PARAM_TASK_ID = "x-xiaoyi-task-id";
const EXTRA_PARAM_SESSION_ID = "x-xiaoyi-session-id";
const EXTRA_PARAM_MESSAGE_ID = "x-xiaoyi-message-id";

export const xiaoyiOpenaiProvider: ProviderPlugin = {
  id: "xiaoyi-openai",
  label: "Xiaoyi OpenAI",
  docsPath: "/providers/models",
  auth: [],

  /**
   * Inject dynamic session params into extraParams so they flow
   * through to wrapStreamFn's ctx.extraParams.
   *
   * Reads from AsyncLocalStorage (set by bot.ts runWithSessionContext)
   * which automatically fetches the latest taskId from task-manager
   * (handles steer mode taskId switching).
   */
  prepareExtraParams: (ctx) => {
    const sessionCtx = getCurrentSessionContext();
    if (!sessionCtx) return undefined;

    return {
      ...ctx.extraParams,
      [EXTRA_PARAM_TASK_ID]: sessionCtx.taskId,
      [EXTRA_PARAM_SESSION_ID]: sessionCtx.sessionId,
      [EXTRA_PARAM_MESSAGE_ID]: sessionCtx.messageId,
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
      const messageId = ctx.extraParams[EXTRA_PARAM_MESSAGE_ID];

      if (typeof taskId === "string") dynamicHeaders[HEADER_TASK_ID] = taskId;
      if (typeof sessionId === "string") dynamicHeaders[HEADER_SESSION_ID] = sessionId;
      if (typeof messageId === "string") dynamicHeaders[HEADER_MESSAGE_ID] = messageId;
    }

    if (Object.keys(dynamicHeaders).length === 0) return underlying;

    return (model, context, options) => {
      return underlying(model, context, {
        ...options,
        headers: {
          ...options?.headers,
          ...dynamicHeaders,
        },
      });
    };
  },
};
