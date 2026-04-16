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
        const displayDevice = (rawDevice === "phone") ? "phone" : "鸿蒙PC";
        const deviceSection = `\n\n## Current User Device Context\nThe current user is using the following device: ${displayDevice}\n`;
        context.systemPrompt = (context.systemPrompt ?? "") + deviceSection;
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
        (err) => console.log(`[xiaoyiprovider] stream error: ${JSON.stringify(err)}`),
      );

      return stream;
    };
  },
};
