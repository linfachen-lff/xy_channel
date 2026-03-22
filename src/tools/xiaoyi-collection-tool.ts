// XiaoYi Collection tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY collection tool - retrieves user's collection data from XiaoYi.
 * Returns personalized knowledge data saved in user's collection.
 */
export const xiaoyiCollectionTool: any = {
  name: "xiaoyi_collection",
  label: "XiaoYi Collection",
  description: "检索用户在小艺收藏中记下来的公共知识数据，可以给用户提供个性化体验。当用户语料中涉及从我的小艺收藏或者查看我的收藏或者我xx时候收藏的xxx帮我看一下这种类型的语料的时候需要使用此工具。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      queryAll: {
        type: "string",
        description: "描述是否需要查询用户所有收藏数据，默认为true",
        default: "true",
      },
    },
    required: [],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[XIAOYI_COLLECTION_TOOL] 🚀 Starting execution`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Get session context
    logger.log(`[XIAOYI_COLLECTION_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[XIAOYI_COLLECTION_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[XIAOYI_COLLECTION_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. XiaoYi collection tool can only be used during an active conversation.");
    }

    logger.log(`[XIAOYI_COLLECTION_TOOL] ✅ Session context found`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[XIAOYI_COLLECTION_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[XIAOYI_COLLECTION_TOOL] ✅ WebSocket manager obtained`);

    // Build QueryCollection command
    logger.log(`[XIAOYI_COLLECTION_TOOL] 📦 Building QueryCollection command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "QueryCollection",
          bundleName: "com.huawei.hmos.vassistant",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            queryAll: params.queryAll || "true",
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

    // Send command and wait for response (60 second timeout)
    logger.log(`[XIAOYI_COLLECTION_TOOL] ⏳ Setting up promise to wait for collection query response...`);
    logger.log(`[XIAOYI_COLLECTION_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[XIAOYI_COLLECTION_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("查询小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[XIAOYI_COLLECTION_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "QueryCollection") {
          logger.log(`[XIAOYI_COLLECTION_TOOL] 🎯 QueryCollection event received`);
          logger.log(`[XIAOYI_COLLECTION_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[XIAOYI_COLLECTION_TOOL] ✅ Collection query completed successfully`);
            logger.log(`[XIAOYI_COLLECTION_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code first
            if (event.outputs.code && event.outputs.code !== 0) {
              logger.error(`[XIAOYI_COLLECTION_TOOL] ❌ Query failed with error code: ${event.outputs.code}`);
              reject(new Error(`查询小艺收藏失败 (错误码: ${event.outputs.code})`));
              return;
            }

            // Get the result from outputs
            const result = event.outputs.result;

            // Check if result exists
            if (!result) {
              logger.warn(`[XIAOYI_COLLECTION_TOOL] ⚠️ No collection data found`);
              resolve({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      memoryInfo: [],
                      message: "未找到收藏数据"
                    }),
                  },
                ],
              });
              return;
            }

            // Extract memoryInfo from the nested result structure
            const memoryInfo = result.result?.memoryInfo || [];
            logger.log(`[XIAOYI_COLLECTION_TOOL] 📊 Collections found: ${memoryInfo.length} items`);

            // Process and simplify the collection data
            const simplifiedCollections = memoryInfo.map((item: any) => ({
              uuid: item.uuid,
              type: item.type,
              status: item.status,
              collectionTime: item.collectionTime,
              editTime: item.editTime,
              title: item.linkTitle || item.aiTitle || item.textTitle || item.imageTitle || item.podcastTitle || "",
              description: item.description || item.abstract || "",
              content: item.textContent || "",
              linkUrl: item.linkUrl,
              linkType: item.linkType,
              appName: item.appNameFromPab || item.appName || "",
              labels: item.label || [],
              collectionMethod: item.collectionMethod,
            }));

            // Return the result with valid string content
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    totalResults: simplifiedCollections.length,
                    collections: simplifiedCollections,
                    message: result.message,
                  }),
                },
              ],
            });
          } else {
            logger.error(`[XIAOYI_COLLECTION_TOOL] ❌ Collection query failed`);
            logger.error(`[XIAOYI_COLLECTION_TOOL]   - status: ${event.status}`);
            reject(new Error(`查询小艺收藏失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[XIAOYI_COLLECTION_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[XIAOYI_COLLECTION_TOOL] 📤 Sending QueryCollection command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[XIAOYI_COLLECTION_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[XIAOYI_COLLECTION_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
