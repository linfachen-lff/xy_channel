// Search Message tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search message tool - searches SMS messages on user's device.
 * Returns matching messages based on content keyword search.
 */
export const searchMessageTool: any = {
  name: "search_message",
  label: "Search Message",
  description: "搜索手机短信。根据关键词搜索短信内容。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "搜索关键词，用于在短信内容中进行匹配",
      },
    },
    required: ["content"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_MESSAGE_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_MESSAGE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate content parameter
    if (!params.content || typeof params.content !== "string" || params.content.trim() === "") {
      logger.error(`[SEARCH_MESSAGE_TOOL] ❌ Missing or invalid content parameter`);
      throw new Error("Missing required parameter: content must be a non-empty string");
    }

    logger.log(`[SEARCH_MESSAGE_TOOL] 🔍 Searching for messages with keyword: ${params.content}`);

    // Get session context
    logger.log(`[SEARCH_MESSAGE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_MESSAGE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_MESSAGE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search message tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_MESSAGE_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_MESSAGE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_MESSAGE_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchMessage command
    logger.log(`[SEARCH_MESSAGE_TOOL] 📦 Building SearchMessage command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchMessage",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            content: params.content.trim(),
          },
          permissionId: [],
          achieveType: "INTENT",
        },
        responses: [
          {
            resultCode: "",
            displayText: "",
            ttsText: "",
          },
        ],
        needUploadResult: true,
        noHalfPage: false,
        pageControlRelated: false,
      },
    };

    logger.log(`[SEARCH_MESSAGE_TOOL] 📋 Command details:`, JSON.stringify(command, null, 2));

    // Send command and wait for response (60 second timeout)
    logger.log(`[SEARCH_MESSAGE_TOOL] ⏳ Setting up promise to wait for message search response...`);
    logger.log(`[SEARCH_MESSAGE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_MESSAGE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("搜索短信超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_MESSAGE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchMessage") {
          logger.log(`[SEARCH_MESSAGE_TOOL] 🎯 SearchMessage event received`);
          logger.log(`[SEARCH_MESSAGE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_MESSAGE_TOOL] ✅ Message search response received`);
            logger.log(`[SEARCH_MESSAGE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[SEARCH_MESSAGE_TOOL] ❌ Device returned error`);
              logger.error(`[SEARCH_MESSAGE_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[SEARCH_MESSAGE_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`搜索短信失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result.items with safe checks
            const result = event.outputs.result;
            let items = [];

            if (result && typeof result === "object" && Array.isArray(result.items)) {
              items = result.items;
              logger.log(`[SEARCH_MESSAGE_TOOL] 📋 Found ${items.length} message(s)`);
            } else {
              logger.warn(`[SEARCH_MESSAGE_TOOL] ⚠️ No items found in result or result is invalid`);
              logger.warn(`[SEARCH_MESSAGE_TOOL]   - result:`, JSON.stringify(result || {}));
            }

            // Return items array as JSON string
            logger.log(`[SEARCH_MESSAGE_TOOL] 🎉 Message search completed successfully`);
            logger.log(`[SEARCH_MESSAGE_TOOL]   - keyword: ${params.content}`);
            logger.log(`[SEARCH_MESSAGE_TOOL]   - result count: ${items.length}`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(items),
                },
              ],
            });
          } else {
            logger.error(`[SEARCH_MESSAGE_TOOL] ❌ Message search failed`);
            logger.error(`[SEARCH_MESSAGE_TOOL]   - status: ${event.status}`);
            logger.error(`[SEARCH_MESSAGE_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`搜索短信失败: ${errorDetail}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_MESSAGE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_MESSAGE_TOOL] 📤 Sending SearchMessage command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEARCH_MESSAGE_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEARCH_MESSAGE_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
