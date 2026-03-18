// Search File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search file tool - searches files on user's device file system.
 * Returns matching files based on keyword search in file name or content.
 */
export const searchFileTool: any = {
  name: "search_file",
  label: "Search File",
  description: `搜索手机文件系统的文件。

【重要】使用约束：此工具仅在用户显著说明要从手机搜索时才执行，例如：
- "从我手机里面搜索xxxx"
- "从手机文件系统找一下xxxx"
- "在手机上查找文件xxxx"
- "搜索手机里的文件"

如果用户没有明确说明从手机搜索（如仅说"搜索文件"、"找一下xxxx"），应默认从 openclaw 本地的文件系统查询，不要调用此工具。

功能说明：根据关键词搜索文件名称或内容，返回匹配的文件列表（包括文件名、路径、大小、修改时间等信息）。

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，用于匹配文件名称、后缀名或文件内容",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_FILE_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_FILE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_FILE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_FILE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate query parameter
    if (!params.query || typeof params.query !== "string" || params.query.trim() === "") {
      logger.error(`[SEARCH_FILE_TOOL] ❌ Missing or invalid query parameter`);
      throw new Error("Missing required parameter: query must be a non-empty string");
    }

    logger.log(`[SEARCH_FILE_TOOL] 🔍 Searching for files with keyword: ${params.query}`);

    // Get session context
    logger.log(`[SEARCH_FILE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_FILE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_FILE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search file tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_FILE_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_FILE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_FILE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_FILE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_FILE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_FILE_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchFile command
    logger.log(`[SEARCH_FILE_TOOL] 📦 Building SearchFile command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchFile",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            query: params.query.trim(),
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

    logger.log(`[SEARCH_FILE_TOOL] 📋 Command details:`, JSON.stringify(command, null, 2));

    // Send command and wait for response (60 second timeout)
    logger.log(`[SEARCH_FILE_TOOL] ⏳ Setting up promise to wait for file search response...`);
    logger.log(`[SEARCH_FILE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_FILE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("搜索文件超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_FILE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchFile") {
          logger.log(`[SEARCH_FILE_TOOL] 🎯 SearchFile event received`);
          logger.log(`[SEARCH_FILE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_FILE_TOOL] ✅ File search response received`);
            logger.log(`[SEARCH_FILE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[SEARCH_FILE_TOOL] ❌ Device returned error`);
              logger.error(`[SEARCH_FILE_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[SEARCH_FILE_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`搜索文件失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result.items with safe checks
            const result = event.outputs.result;
            let items = [];

            if (result && typeof result === "object" && Array.isArray(result.items)) {
              items = result.items;
              logger.log(`[SEARCH_FILE_TOOL] 📋 Found ${items.length} file(s)`);
            } else {
              logger.warn(`[SEARCH_FILE_TOOL] ⚠️ No items found in result or result is invalid`);
              logger.warn(`[SEARCH_FILE_TOOL]   - result:`, JSON.stringify(result || {}));
            }

            // Return items array as JSON string
            logger.log(`[SEARCH_FILE_TOOL] 🎉 File search completed successfully`);
            logger.log(`[SEARCH_FILE_TOOL]   - keyword: ${params.query}`);
            logger.log(`[SEARCH_FILE_TOOL]   - result count: ${items.length}`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(items),
                },
              ],
            });
          } else {
            logger.error(`[SEARCH_FILE_TOOL] ❌ File search failed`);
            logger.error(`[SEARCH_FILE_TOOL]   - status: ${event.status}`);
            logger.error(`[SEARCH_FILE_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`搜索文件失败: ${errorDetail}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_FILE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_FILE_TOOL] 📤 Sending SearchFile command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEARCH_FILE_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEARCH_FILE_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
