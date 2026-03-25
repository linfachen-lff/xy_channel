// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xyPlugin } from "./src/channel.js";
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { callCsplApi } from "./src/cspl/call-api.js";
import { extractResultText, processText } from "./src/cspl/utils.js";
import {
  ALLOWED_TOOLS,
  MIN_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  STEER_ABORT_MESSAGE,
  CSPL_ABORT_ANSWER,
} from "./src/cspl/constants.js";

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

    // CSPL after_tool_call hook: 监听工具结果，发送至 CSPL API 进行安全检测
    // 如果响应为 abort，注入 steer 消息中止当前对话
    api.on("after_tool_call", async (event, ctx) => {
      // 只处理白名单内的工具
      if (!ALLOWED_TOOLS.includes(event.toolName)) {
        return;
      }

      api.logger.info(
        `[CSPL] after_tool_call triggered: toolName=${event.toolName}, sessionKey=${ctx.sessionKey ?? "none"}`,
      );

      try {
        // 提取并处理工具结果文本
        const resultText = extractResultText(event, event.toolName);
        const resultLength = resultText.length;

        if (resultLength <= MIN_TEXT_LENGTH) {
          api.logger.info("[CSPL] No valid text in tool result, skipping");
          return;
        }

        if (resultLength > MAX_TOTAL_LENGTH) {
          api.logger.warn(
            `[CSPL] Tool result exceeds ${MAX_TOTAL_LENGTH} char limit (actual: ${resultLength}), skipping`,
          );
          return;
        }

        const finalText = processText(resultText);
        api.logger.info(
          `[CSPL] Sending to CSPL API, text length: ${finalText.length}`,
        );

        // 调用 CSPL API 进行安全检测
        const response = await callCsplApi(finalText, api.config);
        api.logger.info(
          `[CSPL] API response: answer=${response?.answer ?? "none"}`,
        );

        // 检查是否需要触发 steer 中止
        if (response?.answer === CSPL_ABORT_ANSWER) {
          api.logger.info(
            `[CSPL] 🚨 Abort signal received, injecting steer message`,
          );
          const injected = await tryInjectSteer(
            ctx.sessionKey,
            STEER_ABORT_MESSAGE,
          );
          api.logger.info(`[CSPL] Steer injection result: ${injected}`);
        }
      } catch (err) {
        api.logger.error(`[CSPL] after_tool_call error: ${err}`);
      }
    });
  },
};

export default plugin;

// Also export the plugin directly for testing
export { xyPlugin };
