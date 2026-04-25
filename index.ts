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
const SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE =
  "[系统消息，非用户发言，无需主动告知用户] 当前用户请求中可能包含用户长期偏好、行为纠正意图、经验沉淀需求。如果你已经从当前问题中识别出稳定、可复用的处理规则或排错经验，或者用户表达了明显的具备长期约束力的纠错与反馈，可以在完成当前主要任务后，正式回复用户前，阅读 xiaoyi-self-evolution 技能了解自进化规则。注意，不要打断当前主任务，以完成任务为最高优先级。";
const SELF_EVOLUTION_KEYWORD_PATTERNS = [
  /进化/u,
  /沉淀/u,
  /记住/u,
  /记下来/u,
  /记一下/u,
  /长期记住/u,
  /永久记住/u,
  /永远记住/u,
  /形成规范/u,
  /固化下来/u,
  /固定下来/u,
  /记成规则/u,
  /纳入经验/u,
  /写入经验/u,
  /沉淀成(?:经验|规则|规范|流程)/u,
  /总结成(?:经验|规则|规范|流程|步骤)/u,
  /归纳成(?:经验|规则|规范|流程)/u,
  /提炼成(?:经验|规则|规范|流程)/u,
  /以后都按这个来/u,
  /下次都这样处理/u,
  /以后统一这样/u,
  /后面都这样/u,
  /后续按这个(?:规范|流程|模板|方案)/u,
  /以后(?:遇到|碰到)这种情况/u,
  /类似(?:问题|情况|场景)都这样处理/u,
  /避免(?:再次|以后|下次)/u,
  /避免再(?:犯|错|踩坑|出错)/u,
  /防止以后再犯/u,
  /别再(?:出错|犯错|踩坑|漏掉|忘记)/u,
  /不要再(?:出错|犯错|踩坑|漏掉|忘记)/u,
  /下次别再/u,
  /以后不要再/u,
  /以后别再/u,
  /这个坑(?:要)?记住/u,
  /吸取这次(?:教训|经验)/u,
  /(?:以后|下次|后续|之后)(?:都|统一|默认|应该|要|就)?(?:按这个|这样|这么)(?:来|做|处理|执行)/u,
  /(?:以后|下次|后续|之后)(?:遇到|碰到)(?:类似)?(?:问题|情况|场景)(?:时)?(?:都|就)?(?:按这个|这样|这么)(?:来|做|处理|执行)/u,
  /(?:别再|不要再|避免)(?:犯错|出错|踩坑|漏掉|遗漏|忘记)/u,
  /(?:总结|归纳|提炼|沉淀|复盘)(?:一下)?(?:这次|这个)?(?:经验|教训|问题|规则|规范|流程)?/u,
  /(?:把)?这次(?:经验|教训|规则|做法)(?:记住|记下来|沉淀下来|固化下来)/u,
  /(?:形成|整理成|沉淀成|提炼成)(?:一套)?(?:规则|规范|流程|步骤|最佳实践)/u,
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
