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


const SELF_EVOLUTION_NUDGE_MESSAGE =
  "[系统消息，非用户发言，无需主动告知用户] 当前任务已经调用了较多次数的工具。如果你识别到其中存在可复用的解决方法或踩坑经验等，可以在完成当前主要任务后，正式回复用户前，阅读xiaoyi-self-evolution技能了解自进化规则。注意，不要打断当前主任务，以完成任务为最高优先级。";
const SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE =
  "[系统消息，非用户发言，无需主动告知用户] 当前用户请求中可能包含希望沉淀经验、长期记忆、避免重复踩坑的意图。如果你从当前任务过程中识别出可长期记忆、可复用的处理规则或排错经验等，可以在完成当前主要任务后，正式回复用户前，阅读xiaoyi-self-evolution技能了解自进化规则。注意，不要打断当前主任务，以完成任务为最高优先级。";
const SELF_EVOLUTION_KEYWORD_PATTERNS = [
  /进化|自进化|沉淀|复盘|总结|归纳/u,
  /记住|记下|记一下|记录一下|留档|沉淀下来/u,
  /以后|下次|后面|将来|之后/u,
  /别再|不要再|下次别|以后别|别犯|别踩/u,
  /避免|防止|规避|绕开/u,
  /经验|教训|踩坑|坑点|注意点|排错思路|处理套路/u,
  /以后.*(这样|这么|这么做|按这个来|处理)/u,
  /下次.*(这样|这么|注意|记住|别再|不要再)/u,
  /类似(问题|情况|场景).*(处理|应对|别再|注意)/u,
  /这个.*(要记住|记一下|沉淀|总结)/u,
  /把.*(经验|教训|规则|做法).*(记住|记下|沉淀)/u,
  /(形成|固定|沉淀).*(规范|流程|规则|模板)/u,
  /(以后|后续).*(优先|默认|尽量|统一).*(使用|采用|按)/u,
  /我希望你.*(记住|以后|下次|避免|优先)/u,
  /这种情况.*(以后|下次).*(怎么处理|别再|注意)/u,
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
  },
};

export default plugin;
