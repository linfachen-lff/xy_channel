// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xyPlugin } from "./src/channel.js";
import { xiaoyiProvider } from "./src/provider.js";
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { callCsplApi } from "./src/cspl/call-api.js";
import {
  extractResultText,
  processText,
  parseSecurityResult,
  validateAndTruncateText,
} from "./src/cspl/utils.js";
import { selfEvolutionManager } from "./src/utils/self-evolution-manager.js";
import {
  TOOL_CALL_NUDGE_THRESHOLD,
  toolCallNudgeManager,
} from "./src/utils/tool-call-nudge-manager.js";
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
  "[系统消息，非用户发言，不需要告知用户] 当前任务已经调用了较多工具。如果你识别到其中存在稳定、可复用的踩坑经验或排错模式，可以在完成当前主要任务后，正式回复用户前，阅读xiaoyi-self-evolution技能了解自进化规则。注意，不要打断当前主任务，已完成任务为最高优先级。";
const SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE =
  "[系统消息，非用户发言，不需要告知用户] 当前用户请求中可能包含希望沉淀经验、避免重复踩坑的意图。如果你已经从当前问题中识别出稳定、可复用的处理规则或排错经验，可以在完成当前主要任务后，正式回复用户前，阅读xiaoyi-self-evolution技能了解自进化规则。注意，不要打断当前主任务，已完成任务为最高优先级。";
const SELF_EVOLUTION_KEYWORD_PATTERNS = [
  /进化/u,
  /记住/u,
  /永远/u,
  /下次必须/u,
  /沉淀为/u,
  /总结为/u,
  /归纳为/u,
  /以后(?:不要再犯|别再犯|必须|注意|记住)/u,
  /记住这个坑/u,
  /避免下次/u,
  /别再踩坑/u,
  /不要再踩坑/u,
  /下次(?:别再|不要再)/u,
  /以后(?:别再|不要再)(?:出错|犯错|漏掉|踩坑)/u,
  /这个坑要记住/u,
  /记住这次(?:教训|经验|问题)/u,
  /吸取这次(?:教训|经验)/u,
  /总结(?:一下)?这个坑/u,
  /把这个(?:经验|教训|规则)记住/u,
  /以后按这个规则/u,
  /以后都按这个来/u,
  /以后遇到这种情况/u,
  /类似情况(?:下)?不要再/u,
  /这种问题下次不能再出现/u,
  /永远不要再(?:犯|踩|漏)/u,
  /永远记住这次(?:教训|经验)/u,
];



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

function getUserMessageForKeywordDetection(event: { body?: string; content: string }): string {
  return event.body?.trim() || event.content.trim();
}

function shouldNudgeForSelfEvolutionKeyword(text: string): boolean {
  if (!text) {
    return false;
  }

  return SELF_EVOLUTION_KEYWORD_PATTERNS.some((pattern) => pattern.test(text));
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

    api.on("before_dispatch", async (event, ctx) => {
      const selfEvolutionEnabled = await selfEvolutionManager.isEnabled();
      if (!ctx.sessionKey || !selfEvolutionEnabled) {
        return;
      }

      const userText = getUserMessageForKeywordDetection(event);
      if (!shouldNudgeForSelfEvolutionKeyword(userText)) {
        return;
      }

      try {
        const shouldNudge = toolCallNudgeManager.tryMarkKeywordNudge(ctx.sessionKey);
        api.logger.debug?.(
          `[SELF_EVOLUTION] Keyword check hit: sessionKey=${ctx.sessionKey}, shouldNudge=${shouldNudge}`,
        );

        if (shouldNudge) {
          api.logger.info?.(
            `[SELF_EVOLUTION] Keyword-triggered nudge injected: sessionKey=${ctx.sessionKey}`,
          );
          await tryInjectSteer(ctx.sessionKey, SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE);
        }
      } catch (err) {
        api.logger.error(`[SELF_EVOLUTION] before_dispatch keyword nudge error: ${err}`);
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      const selfEvolutionEnabled = await selfEvolutionManager.isEnabled();
      if (
        ctx.sessionKey &&
        selfEvolutionEnabled &&
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
          const { text: trimmed } = validateAndTruncateText(
            originText,
            MAX_TEXT_LENGTH - diff,
          );
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

    const pluginConfig =
      ((api as { pluginConfig?: unknown }).pluginConfig as Record<string, unknown>) || {};
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
