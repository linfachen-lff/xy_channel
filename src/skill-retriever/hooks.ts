import type { PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookAgentContext } from "openclaw/plugins/hooks.js";
import type { ToolRetrieverConfig } from "./types.js";
import { searchTools, formatToolsForContext, extractUserQuery } from "./tool-search.js";

const TOOL_RETRIEVER_HEADER = `## 用户查询相关skill列表如下：

`;

const TOOL_RETRIEVER_FOOTER = `
以上是检索到的、与当前查询相关但用户尚未安装的 skill，优先推荐强相关的 skill（通用兜底工具如 web-search、xiaoyi-gui-agent 仅在无强相关skill时调用）。
对于强相关skill，你需要主动提醒用户可以考虑安装，但禁止直接给用户安装。用户明确希望安装后，使用find-skill执行安装。
若用户已有的skill已能很好地完成当前任务，则无需提醒安装功能相似的skill。
---以下是用户原始请求---
`;

const PLUGIN_LOG_PREFIX = "[skill-retriever]";

const SKIP_KEYWORDS = ["安装","装一下", "下载", "查询", "查找", "install", "卸载", "删除", "重载"];

const SKIP_PATTERNS = [
  "/new",
  "/reset",
  "session was started",
  "a new session was started",

];

function shouldSkipSearch(prompt: string): string | null {
  const trimmedPrompt = prompt.trim();

  if (trimmedPrompt.startsWith("/")) {
    return "query starts with / (built-in command)";
  }

  const lowerPrompt = trimmedPrompt.toLowerCase();
  for (const keyword of SKIP_KEYWORDS) {
    if (lowerPrompt.includes(keyword.toLowerCase())) {
      return `query contains keyword: ${keyword}`;
    }
  }

  for (const pattern of SKIP_PATTERNS) {
    if (lowerPrompt.includes(pattern.toLowerCase())) {
      return `query matches pattern: ${pattern}`;
    }
  }

  return null;
}

export function createBeforePromptBuildHandler(config: ToolRetrieverConfig) {
  return async (
    event: PluginHookBeforePromptBuildEvent,
    ctx?: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> => {
    const userPrompt = event.prompt;

    if (ctx?.sessionKey?.includes(":subagent:")) {
      console.log(`${PLUGIN_LOG_PREFIX} [SKIP] Sub-agent detected, skipping search`);
      return undefined;
    }

    if (!config.enabled) {
      console.log(`${PLUGIN_LOG_PREFIX} [SKIP] Plugin disabled, original query: "${userPrompt}"`);
      return undefined;
    }

    if (!userPrompt || userPrompt.trim().length === 0) {
      console.log(`${PLUGIN_LOG_PREFIX} [SKIP] Empty query`);
      return undefined;
    }

    console.log(`${PLUGIN_LOG_PREFIX} [RECEIVED] Original user query (len=${userPrompt.length}): "${userPrompt}"`);

    const extractedQuery = extractUserQuery(userPrompt);
    console.log(`${PLUGIN_LOG_PREFIX} [EXTRACTED] Extracted user query: "${extractedQuery}"`);

    if (!extractedQuery || extractedQuery.length === 0) {
      console.log(`${PLUGIN_LOG_PREFIX} [SKIP] No valid user query after extraction, skipping search`);
      return undefined;
    }

    const skipReason = shouldSkipSearch(extractedQuery);
    if (skipReason) {
      console.log(`${PLUGIN_LOG_PREFIX} [SKIP] ${skipReason}, extracted query: "${extractedQuery}"`);
      return undefined;
    }

    console.log(`${PLUGIN_LOG_PREFIX} [PROCEED] Calling skill search API (timeout=${config.timeoutMs}ms) for query: "${extractedQuery}"`);

    try {
      const searchResult = await searchTools({
        query: extractedQuery,
        maxTools: config.maxTools,
        includeUninstalledOnly: config.includeUninstalledOnly,
        envFilePath: config.envFilePath,
        serviceUrl: config.serviceUrl,
        apiKey: config.apiKey,
        uid: config.uid,
        timeoutMs: config.timeoutMs,
      });

      if (!searchResult || searchResult.tools.length === 0) {
        console.log(`${PLUGIN_LOG_PREFIX} [RESULT] No skills found for query: "${extractedQuery}"`);
        return undefined;
      }

      console.log(`${PLUGIN_LOG_PREFIX} [RESULT] Found ${searchResult.tools.length} skills, building context...`);
      const toolsContext = formatToolsForContext(searchResult, config.includeUninstalledOnly);

      if (!toolsContext) {
        console.log(`${PLUGIN_LOG_PREFIX} [ERROR] Failed to format skills context for query: "${extractedQuery}"`);
        return undefined;
      }

      console.log(`${PLUGIN_LOG_PREFIX} [SUCCESS] Built context with ${searchResult.tools.length} skills for query: "${extractedQuery}"`);

      return {
        prependContext: TOOL_RETRIEVER_HEADER + toolsContext + TOOL_RETRIEVER_FOOTER,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`${PLUGIN_LOG_PREFIX} [ERROR] ${errorMessage}, original query: "${extractedQuery}"`);
      return undefined;
    }
  };
}
