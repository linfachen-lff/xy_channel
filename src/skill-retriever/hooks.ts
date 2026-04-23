// Inline hook types — not exposed via openclaw/package.json exports yet.
// Mirror from openclaw/src/plugins/types.ts
interface PluginHookBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}
interface PluginHookBeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}
interface PluginHookAgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}
import type { ToolRetrieverConfig } from "./types.js";
import { searchTools, formatToolsForContext, extractUserQuery } from "./tool-search.js";

const TOOL_RETRIEVER_HEADER = `## 用户查询相关skill列表如下：

`;

const TOOL_RETRIEVER_FOOTER = `
以上是检索到的、与当前查询相关但用户尚未安装的skill，请按照以下规则判断是否需要推荐：
1.判断用户当前请求的意图类型：
-若用户请求为查询已有信息、查看状态、执行已有功能或进行常规操作（例如查看定时任务列表），且这些操作无需额外skill即可完成，则不推荐任何skill。
2.仅在以下条件全部满足时，才考虑推荐skill：
-用户请求明确表示需要完成某个具体任务；
-现有能力（包括已安装的skill或系统自带功能）不足以满足该任务。此时，优先推荐与任务强相关的skill。
3.对于强相关且用户尚未安装的skill：
-可主动提醒用户考虑安装，但禁止直接安装；
-用户明确同意后，使用find-skills执行安装。
4.若用户已安装的skill已能很好地完成当前任务，即使存在功能相似的未安装skill，也无需提醒。
---以下是用户原始请求---
`;

const PLUGIN_LOG_PREFIX = "[skill-retriever]";

const SKIP_KEYWORDS = ["安装","装一下", "下载", "查询", "查找", "install", "卸载", "删除", "重载", "定时任务", "重装"];

const SKIP_PATTERNS = [
  "/new", "/reset", "/compact", "/stop", "/think", "/model", "/fast", "/verbose", "/config", "/debug", "/status", "/tasks", "/whoami", "/context", "/skill", "/commands", "/tools"
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
      return undefined;
    }

    if (!config.enabled) {
      return undefined;
    }

    if (!userPrompt || userPrompt.trim().length === 0) {
      return undefined;
    }

    const extractedQuery = extractUserQuery(userPrompt);

    if (!extractedQuery || extractedQuery.length === 0) {
      return undefined;
    }

    const skipReason = shouldSkipSearch(extractedQuery);
    if (skipReason) {
      return undefined;
    }

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
        return undefined;
      }

      console.log(`${PLUGIN_LOG_PREFIX} [RESULT] Found ${searchResult.tools.length} skills, building context...`);
      const toolsContext = formatToolsForContext(searchResult, config.includeUninstalledOnly);

      if (!toolsContext) {
        console.log(`${PLUGIN_LOG_PREFIX} [ERROR] Failed to format skills context`);
        return undefined;
      }

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
