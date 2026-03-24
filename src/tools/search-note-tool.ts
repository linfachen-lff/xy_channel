// Search Note tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search note tool - searches notes on user's device.
 * Returns matching notes based on query string.
 */
export const searchNoteTool: any = {
  name: "search_notes",
  label: "Search Notes",
  description: "搜索用户设备上的备忘录内容。根据关键词在备忘录的标题、内容和附件名称中进行检索。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，用于在备忘录中检索相关内容",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_NOTE_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_NOTE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_NOTE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_NOTE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.query) {
      logger.error(`[SEARCH_NOTE_TOOL] ❌ Missing required parameter: query`);
      throw new Error("Missing required parameter: query is required");
    }

    // Get session context
    logger.log(`[SEARCH_NOTE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();
    if (!sessionContext) {
      logger.error(`[SEARCH_NOTE_TOOL] ❌ FAILED: No active session found!`);
      throw new Error("No active XY session found. Search note tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_NOTE_TOOL] ✅ Session context found`);
    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_NOTE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_NOTE_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchNote command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchNote",
          bundleName: "com.huawei.hmos.notepad",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            query: params.query,
          },
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

    // Send command and wait for response (60 second timeout)
    logger.log(`[SEARCH_NOTE_TOOL] ⏳ Setting up promise to wait for note search response...`);
    logger.log(`[SEARCH_NOTE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_NOTE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("搜索备忘录超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_NOTE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchNote") {
          logger.log(`[SEARCH_NOTE_TOOL] 🎯 SearchNote event received`);
          logger.log(`[SEARCH_NOTE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_NOTE_TOOL] ✅ Note search completed successfully`);
            logger.log(`[SEARCH_NOTE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                },
              ],
            });
          } else {
            logger.error(`[SEARCH_NOTE_TOOL] ❌ Note search failed`);
            logger.error(`[SEARCH_NOTE_TOOL]   - status: ${event.status}`);
            reject(new Error(`搜索备忘录失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_NOTE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_NOTE_TOOL] 📤 Sending SearchNote command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      }).then(() => {
        logger.log(`[SEARCH_NOTE_TOOL] ✅ Command sent successfully, waiting for response...`);
      }).catch((error) => {
        logger.error(`[SEARCH_NOTE_TOOL] ❌ Failed to send command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
    });
  },
};
