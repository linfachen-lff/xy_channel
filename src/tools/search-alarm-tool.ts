// Search Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm search parameters
const RANGE_TYPE_VALUES = ["all", "next", "current"];
const ALARM_STATE_VALUES = [0, 1];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];

/**
 * XY search alarm tool - searches alarms on user's device.
 * Returns matching alarms based on various filter criteria.
 *
 * At least one search criterion must be provided.
 * Multiple criteria can be combined.
 */
export const searchAlarmTool: any = {
  name: "search_alarm",
  label: "Search Alarm",
  description: `检索用户设备上的闹钟。支持多种检索条件，至少需要提供一个检索条件，多个条件可以组合使用。

检索条件（至少提供一个）：
- rangeType: 查询范围，枚举值：all=查询所有闹钟，next=查找下一个响铃闹钟，current=一小时内最近一次增查改的闹钟
- alarmState: 闹钟开启状态，0=关闭，1=开启
- daysOfWakeType: 闹钟响铃类型，0=单次响铃，1=法定节假日，2=每天，3=自定义时间，4=法定工作日
- startTime: 时间间隔开始，格式 YYYYMMDD hhmmss（例如：20240315 000000），需要与 endTime 一起使用
- endTime: 时间间隔结束，格式 YYYYMMDD hhmmss（例如：20240315 235959），需要与 startTime 一起使用

使用示例：
- 查询所有闹钟：{"rangeType": "all"}
- 查询已开启的闹钟：{"alarmState": 1}
- 查询每天响铃的闹钟：{"daysOfWakeType": 2}
- 查询某个时间段的闹钟：{"startTime": "20240315 000000", "endTime": "20240315 235959"}

注意：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      rangeType: {
        type: "string",
        enum: ["all", "next", "current"],
        description: "查询范围：all=所有闹钟，next=下一个响铃闹钟，current=一小时内最近修改的闹钟",
      },
      alarmState: {
        type: "number",
        enum: [0, 1],
        description: "闹钟开启状态：0=关闭，1=开启",
      },
      daysOfWakeType: {
        type: "number",
        enum: [0, 1, 2, 3, 4],
        description: "闹钟响铃类型：0=单次，1=法定节假日，2=每天，3=自定义，4=法定工作日",
      },
      startTime: {
        type: "string",
        description: "时间间隔开始，格式 YYYYMMDD hhmmss（例如：20240315 000000），必须与 endTime 一起使用",
      },
      endTime: {
        type: "string",
        description: "时间间隔结束，格式 YYYYMMDD hhmmss（例如：20240315 235959），必须与 startTime 一起使用",
      },
    },
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_ALARM_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_ALARM_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_ALARM_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== Validate at least one search criterion is provided =====
    const hasRangeType = params.rangeType !== undefined && params.rangeType !== null;
    const hasAlarmState = params.alarmState !== undefined && params.alarmState !== null;
    const hasDaysOfWakeType = params.daysOfWakeType !== undefined && params.daysOfWakeType !== null;
    const hasStartTime = params.startTime !== undefined && params.startTime !== null;
    const hasEndTime = params.endTime !== undefined && params.endTime !== null;

    if (!hasRangeType && !hasAlarmState && !hasDaysOfWakeType && !hasStartTime && !hasEndTime) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ No search criteria provided`);
      throw new Error("至少需要提供一个检索条件：rangeType、alarmState、daysOfWakeType 或时间范围（startTime + endTime）");
    }

    // ===== Validate rangeType =====
    if (hasRangeType) {
      if (typeof params.rangeType !== "string") {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid rangeType type`);
        throw new Error("rangeType must be a string");
      }
      if (!RANGE_TYPE_VALUES.includes(params.rangeType)) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid rangeType value: ${params.rangeType}`);
        throw new Error(`rangeType must be one of: ${RANGE_TYPE_VALUES.join(", ")}`);
      }
      logger.log(`[SEARCH_ALARM_TOOL]   - rangeType: ${params.rangeType}`);
    }

    // ===== Validate alarmState =====
    if (hasAlarmState) {
      if (typeof params.alarmState !== "number") {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid alarmState type`);
        throw new Error("alarmState must be a number");
      }
      if (!ALARM_STATE_VALUES.includes(params.alarmState)) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid alarmState value: ${params.alarmState}`);
        throw new Error(`alarmState must be one of: ${ALARM_STATE_VALUES.join(", ")}`);
      }
      logger.log(`[SEARCH_ALARM_TOOL]   - alarmState: ${params.alarmState}`);
    }

    // ===== Validate daysOfWakeType =====
    if (hasDaysOfWakeType) {
      if (typeof params.daysOfWakeType !== "number") {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid daysOfWakeType type`);
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid daysOfWakeType value: ${params.daysOfWakeType}`);
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
      logger.log(`[SEARCH_ALARM_TOOL]   - daysOfWakeType: ${params.daysOfWakeType}`);
    }

    // ===== Validate time interval (startTime and endTime must be provided together) =====
    if (hasStartTime !== hasEndTime) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ startTime and endTime must be provided together`);
      throw new Error("startTime 和 endTime 必须一起提供");
    }

    let timeInterval: [number, number] | null = null;
    if (hasStartTime && hasEndTime) {
      // Parse and convert startTime and endTime to timestamps
      logger.log(`[SEARCH_ALARM_TOOL] 🕒 Parsing time interval...`);
      logger.log(`[SEARCH_ALARM_TOOL]   - startTime input: ${params.startTime}`);
      logger.log(`[SEARCH_ALARM_TOOL]   - endTime input: ${params.endTime}`);

      const startTimeMs = parseAlarmTimeToTimestamp(params.startTime);
      const endTimeMs = parseAlarmTimeToTimestamp(params.endTime);

      if (startTimeMs === null) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid startTime format`);
        throw new Error("Invalid startTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 000000)");
      }
      if (endTimeMs === null) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid endTime format`);
        throw new Error("Invalid endTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 235959)");
      }

      if (startTimeMs >= endTimeMs) {
        logger.error(`[SEARCH_ALARM_TOOL] ❌ startTime must be before endTime`);
        throw new Error("startTime 必须早于 endTime");
      }

      timeInterval = [startTimeMs, endTimeMs];
      logger.log(`[SEARCH_ALARM_TOOL] ✅ Time interval parsed: [${startTimeMs}, ${endTimeMs}]`);
    }

    // Get session context
    logger.log(`[SEARCH_ALARM_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search alarm tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_ALARM_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_ALARM_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_ALARM_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_ALARM_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_ALARM_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_ALARM_TOOL] ✅ WebSocket manager obtained`);

    // Build SearchAlarm command
    logger.log(`[SEARCH_ALARM_TOOL] 📦 Building SearchAlarm command...`);

    // Build intentParam with provided search criteria
    const intentParam: any = {};

    if (hasRangeType) {
      intentParam.rangeType = params.rangeType;
    }
    if (hasAlarmState) {
      intentParam.alarmState = params.alarmState;
    }
    if (hasDaysOfWakeType) {
      intentParam.daysOfWakeType = params.daysOfWakeType;
    }
    if (timeInterval) {
      intentParam.timeInterval = timeInterval;
    }

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SearchAlarm",
          bundleName: "com.huawei.hmos.clock",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam,
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
    logger.log(`[SEARCH_ALARM_TOOL] ⏳ Setting up promise to wait for alarm search response...`);
    logger.log(`[SEARCH_ALARM_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEARCH_ALARM_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("检索闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEARCH_ALARM_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SearchAlarm") {
          logger.log(`[SEARCH_ALARM_TOOL] 🎯 SearchAlarm event received`);
          logger.log(`[SEARCH_ALARM_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEARCH_ALARM_TOOL] ✅ Alarm search completed successfully`);
            logger.log(`[SEARCH_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[SEARCH_ALARM_TOOL] ❌ Device returned error`);
              logger.error(`[SEARCH_ALARM_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[SEARCH_ALARM_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`检索闹钟失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result.items with safe checks
            const result = event.outputs.result;
            let items: any[] = [];

            if (result && typeof result === "object" && Array.isArray(result.items)) {
              items = result.items;
              logger.log(`[SEARCH_ALARM_TOOL] 📋 Found ${items.length} alarm(s)`);

              // Parse JSON strings in items array
              // Items are returned as JSON strings that need to be parsed
              const parsedItems = items.map((itemStr, index) => {
                if (typeof itemStr !== "string") {
                  logger.warn(`[SEARCH_ALARM_TOOL] ⚠️ Item at index ${index} is not a string:`, typeof itemStr);
                  return null;
                }
                try {
                  const parsed = JSON.parse(itemStr);
                  logger.log(`[SEARCH_ALARM_TOOL] 📋 Parsed alarm [${index}]:`, JSON.stringify(parsed));
                  return parsed;
                } catch (parseError) {
                  logger.error(`[SEARCH_ALARM_TOOL] ❌ Failed to parse item at index ${index}:`, parseError);
                  logger.error(`[SEARCH_ALARM_TOOL]   - itemStr: ${itemStr}`);
                  return null;
                }
              }).filter((item) => item !== null);

              logger.log(`[SEARCH_ALARM_TOOL] 🎉 Successfully parsed ${parsedItems.length} alarm(s)`);

              resolve({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(parsedItems),
                  },
                ],
              });
            } else {
              logger.warn(`[SEARCH_ALARM_TOOL] ⚠️ No items found in result or result is invalid`);
              logger.warn(`[SEARCH_ALARM_TOOL]   - result:`, JSON.stringify(result || {}));

              // Return empty array
              resolve({
                content: [
                  {
                    type: "text",
                    text: "[]",
                  },
                ],
              });
            }
          } else {
            logger.error(`[SEARCH_ALARM_TOOL] ❌ Alarm search failed`);
            logger.error(`[SEARCH_ALARM_TOOL]   - status: ${event.status}`);
            logger.error(`[SEARCH_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));
            reject(new Error(`检索闹钟失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEARCH_ALARM_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEARCH_ALARM_TOOL] 📤 Sending SearchAlarm command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEARCH_ALARM_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEARCH_ALARM_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

/**
 * Parse alarmTime string (YYYYMMDD hhmmss) to timestamp in milliseconds
 * @param alarmTime - Time string in format "YYYYMMDD hhmmss" (e.g., "20240315 143000")
 * @returns Timestamp in milliseconds, or null if parsing fails
 */
function parseAlarmTimeToTimestamp(alarmTime: string): number | null {
  try {
    // Expected format: YYYYMMDD hhmmss
    // Example: 20240315 143000
    const trimmed = alarmTime.trim();

    // Check basic format (should have at least 13 characters: YYYYMMDD hhmmss)
    if (trimmed.length < 13) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ alarmTime too short: ${trimmed}`);
      return null;
    }

    // Extract date and time parts
    // Format: YYYYMMDD hhmmss
    const datePart = trimmed.substring(0, 8); // YYYYMMDD
    const timePart = trimmed.substring(8).trim(); // hhmmss (may have leading space)

    logger.log(`[SEARCH_ALARM_TOOL]   - datePart: ${datePart}, timePart: ${timePart}`);

    // Validate lengths
    if (datePart.length !== 8 || timePart.length !== 6) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid part lengths: datePart=${datePart.length}, timePart=${timePart.length}`);
      return null;
    }

    // Parse components
    const year = parseInt(datePart.substring(0, 4), 10);
    const month = parseInt(datePart.substring(4, 6), 10);
    const day = parseInt(datePart.substring(6, 8), 10);
    const hour = parseInt(timePart.substring(0, 2), 10);
    const minute = parseInt(timePart.substring(2, 4), 10);
    const second = parseInt(timePart.substring(4, 6), 10);

    logger.log(`[SEARCH_ALARM_TOOL]   - Parsed: ${year}-${month}-${day} ${hour}:${minute}:${second}`);

    // Validate values
    if (isNaN(year) || isNaN(month) || isNaN(day) ||
        isNaN(hour) || isNaN(minute) || isNaN(second)) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ NaN detected in parsed values`);
      return null;
    }

    // Validate ranges
    if (month < 1 || month > 12) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid month: ${month}`);
      return null;
    }
    if (day < 1 || day > 31) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid day: ${day}`);
      return null;
    }
    if (hour < 0 || hour > 23) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid hour: ${hour}`);
      return null;
    }
    if (minute < 0 || minute > 59) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid minute: ${minute}`);
      return null;
    }
    if (second < 0 || second > 59) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Invalid second: ${second}`);
      return null;
    }

    // Create Date object and get timestamp
    const date = new Date(year, month - 1, day, hour, minute, second);
    const timestamp = date.getTime();

    if (isNaN(timestamp)) {
      logger.error(`[SEARCH_ALARM_TOOL] ❌ Generated timestamp is NaN`);
      return null;
    }

    return timestamp;
  } catch (error) {
    logger.error(`[SEARCH_ALARM_TOOL] ❌ Exception in parseAlarmTimeToTimestamp:`, error);
    return null;
  }
}
