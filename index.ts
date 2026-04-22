// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xyPlugin } from "./src/channel.js";
import { xiaoyiProvider } from "./src/provider.js";
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { callCsplApi } from "./src/cspl/call-api.js";
import { extractResultText, processText, parseSecurityResult, validateAndTruncateText } from "./src/cspl/utils.js";
import { selfEvolutionManager } from "./src/utils/self-evolution-manager.js";
import { TOOL_CALL_NUDGE_THRESHOLD, toolCallNudgeManager } from "./src/utils/tool-call-nudge-manager.js";
import {
  ALLOWED_TOOLS,
  MIN_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  MAX_TEXT_LENGTH,
  STEER_ABORT_MESSAGE,
} from "./src/cspl/constants.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";

const SELF_EVOLUTION_NUDGE_MESSAGE =
  `[系统消息，非用户发送] 当前任务已经调用了较多工具。如果你识别到存在稳定、可复用的踩坑经验或排错模式，可以在完成当前主要任务后，正式回复用户前，阅读evolution skill开启自进化。注意，不要打断当前主任务，已完成任务为最高优先级。`;

function shouldCountToolCall(toolName: string): boolean {
  if (toolName === "save_self_evolution_skill") {
    return false;
  }

  if (toolName === "call_device_tool") {
    return false;
  }

  if (toolName.endsWith("_tool_schema")) {
    return false;
  }

  return true;
}

/**
 * Xiaoyi Channel Plugin Entry Point.
 * Exports the plugin for OpenClaw to load.
 * Located at root level following feishu pattern for proper plugin registration.
 */
const plugin = {
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXYRuntime(api.runtime);
    api.registerChannel({ plugin: xyPlugin });
    api.registerProvider(xiaoyiProvider);

    // SENTINEL HOOK after_tool_call hook: 监听工具结果，发送至安全检测 API 进行安全检测
    // 如果响应为 REJECT，注入 steer 消息中止当前对话
    api.on("after_tool_call", async (event, ctx) => {
      if (
        ctx.sessionKey &&
        await selfEvolutionManager.isEnabled() &&
        shouldCountToolCall(event.toolName)
      ) {
        try {
          const { count, shouldNudge } = toolCallNudgeManager.recordToolCall(ctx.sessionKey);
          api.logger.debug?.(
            `[SELF_EVOLUTION] Tool call counted: tool=${event.toolName}, count=${count}, threshold=${TOOL_CALL_NUDGE_THRESHOLD}, sessionKey=${ctx.sessionKey}`,
          );

          if (shouldNudge) {
            api.logger.info?.(
              `[SELF_EVOLUTION] Tool call threshold reached, injecting nudge: count=${count}, sessionKey=${ctx.sessionKey}`,
            );
            await tryInjectSteer(ctx.sessionKey, SELF_EVOLUTION_NUDGE_MESSAGE);
          }
        } catch (err) {
          api.logger.error(`[SELF_EVOLUTION] after_tool_call nudge error: ${err}`);
        }
      }

      if (!ALLOWED_TOOLS.includes(event.toolName)) {
        return;
      }

      console.log(`[SENTINEL HOOK] after_tool_call triggered: toolName=${event.toolName}, sessionKey=${ctx.sessionKey ?? "none"}`);

      try {
        const resultText = extractResultText(event, event.toolName);
        const resultLength = resultText.length;

        if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
          return;
        }

        // 构造 sentinel_hook 格式的 payload: { tool, output: [{ content }] }
        const questionText = {
          subSceneID: 'TOOL_OUTPUT',
          tool: event.toolName,
          output: [{ content: "" }],
        };
        const originText = processText(resultText);
        questionText.output[0].content = originText;
        let finalJson = JSON.stringify(questionText);
        if (finalJson.length > MAX_TEXT_LENGTH) {
          const diff = finalJson.length - MAX_TEXT_LENGTH;
          const { text: trimmed } = validateAndTruncateText(originText, MAX_TEXT_LENGTH - diff);
          questionText.output[0].content = trimmed;
          finalJson = JSON.stringify(questionText);
        }

        const response = await callCsplApi(finalJson, api.config);
        const result = parseSecurityResult(response);
        console.log(`[SENTINEL HOOK] Security result: status=${result.status}`);

        if (result.status === "REJECT") {
          await tryInjectSteer(ctx.sessionKey, STEER_ABORT_MESSAGE);
        }
      } catch (err) {
        api.logger.error(`[SENTINEL HOOK] after_tool_call error: ${err}`);
      }
    });

    // SKILL RETRIEVER HOOK: before_prompt_build hook
    const pluginConfig = (api as { pluginConfig?: unknown }).pluginConfig as Record<string, unknown> || {};
    const skillRetrieverConfig = normalizeToolRetrieverConfig({
      enabled: pluginConfig.skillRetrieverEnabled ?? true,
      maxTools: pluginConfig.skillRetrieverMaxTools ?? 2,
      includeUninstalledOnly: true,
      envFilePath: "~/.openclaw/.xiaoyienv",
      timeoutMs: pluginConfig.skillRetrieverTimeoutMs ?? 1000,
    });
    const beforePromptBuildHandler = createBeforePromptBuildHandler(skillRetrieverConfig);
    api.on("before_prompt_build", beforePromptBuildHandler);
  },
};

export default plugin;
