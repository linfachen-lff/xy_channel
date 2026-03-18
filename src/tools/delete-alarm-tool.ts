// Delete Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY delete alarm tool - deletes existing alarms on user's device.
 * Requires entityId(s) from search_alarm or create_alarm tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId(s) of alarms
 * 2. Use the entityId(s) to delete those alarms
 *
 * Supports deleting single or multiple alarms in one call.
 */
export const deleteAlarmTool: any = {
  name: "delete_alarm",
  label: "Delete Alarm",
  description: `删除用户设备上的闹钟。使用前必须先调用 search_alarm 或 create_alarm 工具获取闹钟的 entityId。

工具参数：
- items: 要删除的闹钟列表，每个元素包含 entityId 字段。支持数组或 JSON 字符串格式。entityId 是闹钟的唯一标识符（从 search_alarm 或 create_alarm 工具获取）。

使用示例：
- 删除单个闹钟：{"items": [{"entityId": "6"}]}
- 删除多个闹钟：{"items": [{"entityId": "6"}, {"entityId": "8"}]}

注意事项：
1. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
2. 删除操作不可撤销，请确认 entityId 正确后再删除。
3. items 参数支持数组或 JSON 字符串格式，代码会自动解析。`,
  parameters: {
    type: "object",
    properties: {
      items: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "要删除的闹钟列表，每个元素包含 entityId 字段。支持数组或 JSON 字符串格式。",
      },
    },
    required: ["items"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[DELETE_ALARM_TOOL] 🚀 Starting execution`);
    logger.log(`[DELETE_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[DELETE_ALARM_TOOL]   - params (raw):`, JSON.stringify(params));
    logger.log(`[DELETE_ALARM_TOOL]   - params.items type:`, typeof params.items);
    logger.log(`[DELETE_ALARM_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let items: Array<{ entityId: string }> | null = null;

    if (!params.items) {
      logger.error(`[DELETE_ALARM_TOOL] ❌ Missing parameter: items`);
      throw new Error("Missing required parameter: items");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.items)) {
      logger.log(`[DELETE_ALARM_TOOL] ✅ items is already an array`);
      items = params.items;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.items === 'string') {
      logger.log(`[DELETE_ALARM_TOOL] 🔄 items is a string, attempting to parse as JSON...`);
      try {
        const parsed = JSON.parse(params.items);
        if (Array.isArray(parsed)) {
          logger.log(`[DELETE_ALARM_TOOL] ✅ Successfully parsed JSON string to array`);
          items = parsed;
        } else {
          logger.error(`[DELETE_ALARM_TOOL] ❌ Parsed JSON is not an array:`, typeof parsed);
          throw new Error("items must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        logger.error(`[DELETE_ALARM_TOOL] ❌ Failed to parse items as JSON:`, parseError);
        throw new Error(`items must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      logger.error(`[DELETE_ALARM_TOOL] ❌ Invalid items type:`, typeof params.items);
      throw new Error(`items must be an array or a JSON string, got ${typeof params.items}`);
    }

    // 验证数组非空
    if (!items || items.length === 0) {
      logger.error(`[DELETE_ALARM_TOOL] ❌ items array is empty`);
      throw new Error("items array cannot be empty");
    }

    logger.log(`[DELETE_ALARM_TOOL] ✅ Normalized items:`, JSON.stringify(items));

    // 验证每个 item 是否有有效的 entityId
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        logger.error(`[DELETE_ALARM_TOOL] ❌ Item at index ${i} is not an object`);
        throw new Error(`items[${i}] must be an object with entityId property`);
      }
      if (!item.entityId || typeof item.entityId !== 'string') {
        logger.error(`[DELETE_ALARM_TOOL] ❌ Item at index ${i} missing or invalid entityId`);
        throw new Error(`items[${i}] must have a valid entityId string property`);
      }
    }

    logger.log(`[DELETE_ALARM_TOOL]   - items count: ${items.length}`);
    logger.log(`[DELETE_ALARM_TOOL]   - entityIds:`, items.map(item => item.entityId).join(", "));

    // Get session context
    logger.log(`[DELETE_ALARM_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[DELETE_ALARM_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[DELETE_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Delete alarm tool can only be used during an active conversation.");
    }

    logger.log(`[DELETE_ALARM_TOOL] ✅ Session context found`);
    logger.log(`[DELETE_ALARM_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[DELETE_ALARM_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[DELETE_ALARM_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[DELETE_ALARM_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[DELETE_ALARM_TOOL] ✅ WebSocket manager obtained`);

    // Build DeleteAlarm command
    logger.log(`[DELETE_ALARM_TOOL] 📦 Building DeleteAlarm command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "DeleteAlarm",
          bundleName: "com.huawei.hmos.clock",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            items: items,
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
    logger.log(`[DELETE_ALARM_TOOL] ⏳ Setting up promise to wait for alarm deletion response...`);
    logger.log(`[DELETE_ALARM_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[DELETE_ALARM_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("删除闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[DELETE_ALARM_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "DeleteAlarm") {
          logger.log(`[DELETE_ALARM_TOOL] 🎯 DeleteAlarm event received`);
          logger.log(`[DELETE_ALARM_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[DELETE_ALARM_TOOL] ✅ Alarm deletion completed successfully`);
            logger.log(`[DELETE_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[DELETE_ALARM_TOOL] ❌ Device returned error`);
              logger.error(`[DELETE_ALARM_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[DELETE_ALARM_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`删除闹钟失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result with safe navigation
            const result = event.outputs.result || {};
            logger.log(`[DELETE_ALARM_TOOL] 📋 Deletion result:`, JSON.stringify(result));

            // Build response with safe navigation
            const response: any = {
              success: true,
              entityName: result.entityName || "Alarm",
              message: result.message || "Alarm deleted successfully",
              deletedCount: items.length,
            };

            // Add entityIds from request for reference
            response.deletedIds = items.map(item => item.entityId);

            logger.log(`[DELETE_ALARM_TOOL] 🎉 Successfully deleted ${items.length} alarm(s)`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response),
                },
              ],
            });
          } else {
            logger.error(`[DELETE_ALARM_TOOL] ❌ Alarm deletion failed`);
            logger.error(`[DELETE_ALARM_TOOL]   - status: ${event.status}`);
            logger.error(`[DELETE_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));
            reject(new Error(`删除闹钟失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[DELETE_ALARM_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[DELETE_ALARM_TOOL] 📤 Sending DeleteAlarm command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[DELETE_ALARM_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[DELETE_ALARM_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
