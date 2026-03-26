// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xyPlugin } from "./src/channel.js";
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { callCsplApi } from "./src/cspl/call-api.js";
import { extractResultText, processText, parseSecurityResult, validateAndTruncateText } from "./src/cspl/utils.js";
import {
  ALLOWED_TOOLS,
  MIN_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  MAX_TEXT_LENGTH,
  STEER_ABORT_MESSAGE,
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
    // 如果响应为 REJECT，注入 steer 消息中止当前对话
    api.on("after_tool_call", async (event, ctx) => {
      if (!ALLOWED_TOOLS.includes(event.toolName)) {
        return;
      }

      console.log(`[CSPL] after_tool_call triggered: toolName=${event.toolName}, sessionKey=${ctx.sessionKey ?? "none"}`);

      try {
        const resultText = extractResultText(event, event.toolName);
        const resultLength = resultText.length;

        if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
          return;
        }

        // 构造 sentinel_hook 格式的 payload: { tool, output: [{ content }] }
        const questionText = {
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
        console.log(`[CSPL] Security result: status=${result.status}`);

        if (result.status === "REJECT") {
          await tryInjectSteer(ctx.sessionKey, STEER_ABORT_MESSAGE);
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
