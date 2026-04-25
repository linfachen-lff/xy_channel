// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import { callCsplApi } from "./src/cspl/call-api.js";
import {
  ALLOWED_TOOLS,
  MAX_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  MIN_TEXT_LENGTH,
  STEER_ABORT_MESSAGE,
} from "./src/cspl/constants.js";
import {
  extractResultText,
  parseSecurityResult,
  processText,
  validateAndTruncateText,
} from "./src/cspl/utils.js";
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { selfEvolutionManager } from "./src/utils/self-evolution-manager.js";
import {
  TOOL_CALL_NUDGE_THRESHOLD,
  toolCallNudgeManager,
} from "./src/utils/tool-call-nudge-manager.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";


const SELF_EVOLUTION_NUDGE_MESSAGE =
  "[系统消息，非用户发言，无需主动告知用户] 当前任务已经调用了较多次数的工具。请先完成用户主要任务。完成后，如果这些工具调用暴露出稳定、通用、可复用的流程、排错经验或踩坑点，再考虑阅读 xiaoyi-self-evolution 技能进行评估；如果没有高价值候选经验，请忽略本提醒。";

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

const plugin = {
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXYRuntime(api.runtime);
    api.registerChannel({ plugin: xyPlugin });
    api.registerProvider(xiaoyiProvider);

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

    api.on("after_tool_call", async (event, ctx) => {
      const selfEvolutionEnabled = await selfEvolutionManager.isEnabled();
      if (ctx.sessionKey && selfEvolutionEnabled && shouldCountToolCall(event.toolName)) {
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

      console.log(
        `[SENTINEL HOOK] after_tool_call triggered: toolName=${event.toolName}, sessionKey=${ctx.sessionKey ?? "none"}`,
      );

      try {
        const resultText = extractResultText(event, event.toolName);
        const resultLength = resultText.length;

        if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
          return;
        }

        const questionText = {
          subSceneID: "TOOL_OUTPUT",
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
  },
};

export default plugin;
