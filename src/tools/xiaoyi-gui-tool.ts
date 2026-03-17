// XiaoYi GUI tool implementation - simulates phone screen interactions
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";

/**
 * XiaoYi GUI tool - executes phone app interactions through GUI agent.
 * Simulates user interactions on phone screen (click, swipe, input, navigation, etc.)
 * to complete tasks that cannot be done through internet APIs.
 */
export const xiaoyiGuiTool: any = {
  name: "xiaoyi_gui_agent",
  label: "XiaoYi GUI Agent",
  description: `通过模拟人在手机屏幕上的交互行为（点击、滑动、输入、页面导航等），自动完成手机APP中的各类任务。

该工具操作方式类似真实用户在手机上的操作，因此可以完成许多无法通过互联网API实现的任务，例如：
- 任务需要真实操作手机APP界面
- 数据仅存在于APP内部
- 无法通过互联网API获取数据
- 需要完成用户行为（签到、关注、购买等）
- 需要在APP中发布或发送内容
- 需要修改APP或手机设置

注意事项：
- 操作超时时间为3分钟（180秒）
- 该工具执行时间较长，请勿重复调用
- 该工具执行期间不要执行别的工具调用，必须等到该工具有结果返回或者超时之后才能执行别的操作，无论是新的文本回复还是下一步的工具调用，在此工具执行期间必须严格等待
- 如果超时或失败，最多重试一次
`,

  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "操作手机的指令以及期望返回的结果。",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[XIAOYI_GUI_TOOL] 🚀 Starting execution`);
    logger.log(`[XIAOYI_GUI_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[XIAOYI_GUI_TOOL]   - query: ${params.query}`);
    logger.log(`[XIAOYI_GUI_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.query || typeof params.query !== "string") {
      logger.error(`[XIAOYI_GUI_TOOL] ❌ FAILED: Invalid query parameter`);
      throw new Error("Missing or invalid required parameter: query must be a non-empty string");
    }

    // Get session context
    logger.log(`[XIAOYI_GUI_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[XIAOYI_GUI_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[XIAOYI_GUI_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. XiaoYi GUI tool can only be used during an active conversation.");
    }

    logger.log(`[XIAOYI_GUI_TOOL] ✅ Session context found`);
    logger.log(`[XIAOYI_GUI_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[XIAOYI_GUI_TOOL]   - taskId (interactionId): ${sessionContext.taskId}`);
    logger.log(`[XIAOYI_GUI_TOOL]   - messageId: ${sessionContext.messageId}`);
    logger.log(`[XIAOYI_GUI_TOOL]   - agentId: ${sessionContext.agentId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[XIAOYI_GUI_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[XIAOYI_GUI_TOOL] ✅ WebSocket manager obtained`);

    // Build InvokeJarvisGUIAgentRequest command
    logger.log(`[XIAOYI_GUI_TOOL] 📦 Building InvokeJarvisGUIAgentRequest command...`);
    const command = {
      header: {
        namespace: "ClawAgent",
        name: "InvokeJarvisGUIAgentRequest",
      },
      payload: {
        query: params.query,
        sessionId: sessionId,
        interactionId: taskId, // taskId corresponds to interactionId
      },
    };

    logger.log(`[XIAOYI_GUI_TOOL] 📋 Command details:`, JSON.stringify(command, null, 2));

    // Send command and wait for response (5 minute timeout)
    logger.log(`[XIAOYI_GUI_TOOL] ⏳ Setting up promise to wait for GUI agent response...`);
    logger.log(`[XIAOYI_GUI_TOOL]   - Timeout: 300 seconds (5 minutes)`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[XIAOYI_GUI_TOOL] ⏰ Timeout: No response received within 300 seconds (5 minutes)`);
        wsManager.off("gui-agent-response", handler);
        reject(new Error("XiaoYi GUI Agent 操作超时（5分钟）"));
      }, 180000); // 5 minutes timeout

      // Listen for GUI agent response events
      const handler = (event: any) => {
        logger.log(`[XIAOYI_GUI_TOOL] 📨 Received event:`, JSON.stringify(event));

        // Check if this is the InvokeJarvisGUIAgentResponse we're waiting for
        if (
          event.header?.namespace === "ClawAgent" &&
          event.header?.name === "InvokeJarvisGUIAgentResponse"
        ) {
          logger.log(`[XIAOYI_GUI_TOOL] 🎯 InvokeJarvisGUIAgentResponse event received`);
          logger.log(`[XIAOYI_GUI_TOOL]   - isFinal: ${event.payload?.isFinal}`);

          // According to the spec, we only get one response (isFinal: true)
          if (event.payload?.isFinal === true) {
            clearTimeout(timeout);
            wsManager.off("gui-agent-response", handler);

            const streamContent = event.payload?.streamInfo?.streamContent;

            if (streamContent) {
              logger.log(`[XIAOYI_GUI_TOOL] ✅ GUI Agent operation completed successfully`);
              logger.log(`[XIAOYI_GUI_TOOL]   - streamContent: ${streamContent}`);

              resolve({
                content: [
                  {
                    type: "text",
                    text: streamContent,
                  }
                ]
              });
            } else {
              logger.error(`[XIAOYI_GUI_TOOL] ❌ Response missing streamContent`);
              logger.error(`[XIAOYI_GUI_TOOL]   - payload:`, JSON.stringify(event.payload));
              reject(new Error("XiaoYi GUI Agent 响应格式错误：缺少 streamContent"));
            }
          } else if (event.payload?.isFinal === false) {
            // According to spec, we shouldn't get intermediate responses, but log if we do
            logger.log(`[XIAOYI_GUI_TOOL] 📝 Intermediate response received (isFinal: false), waiting for final...`);
          }
        }
      };

      // Register event handler
      // Note: The WebSocket manager needs to emit 'gui-agent-response' when receiving this type of response
      logger.log(`[XIAOYI_GUI_TOOL] 📡 Registering gui-agent-response handler on WebSocket manager`);
      wsManager.on("gui-agent-response", handler);

      // Send the command
      logger.log(`[XIAOYI_GUI_TOOL] 📤 Sending InvokeJarvisGUIAgentRequest command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      }).then(() => {
        logger.log(`[XIAOYI_GUI_TOOL] ✅ Command sent successfully, waiting for response...`);
        logger.log(`[XIAOYI_GUI_TOOL]   - This may take up to 5 minutes depending on the task complexity`);
      }).catch((error) => {
        logger.error(`[XIAOYI_GUI_TOOL] ❌ Failed to send command:`, error);
        clearTimeout(timeout);
        wsManager.off("gui-agent-response", handler);
        reject(error);
      });
    });
  },
};
