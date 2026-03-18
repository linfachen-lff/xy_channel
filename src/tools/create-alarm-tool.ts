// Create Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm parameters
const ALARM_SNOOZE_DURATION_VALUES = [5, 10, 15, 20, 25, 30];
const ALARM_SNOOZE_TOTAL_VALUES = [0, 1, 3, 5, 10];
const ALARM_RING_DURATION_VALUES = [1, 5, 10, 15, 20, 30];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];
const DAYS_OF_WEEK_VALUES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * XY create alarm tool - creates an alarm on user's device.
 * Requires alarmTime parameter. Other parameters are optional with sensible defaults.
 *
 * Time format: YYYYMMDD hhmmss (e.g., 20240315 143000)
 */
export const createAlarmTool: any = {
  name: "create_alarm",
  label: "Create Alarm",
  description: `在用户设备上创建闹钟。

必需参数：
- alarmTime: 闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000，表示2024年3月15日14:30:00）

可选参数：
- alarmTitle: 闹钟名称/标题，默认为"闹钟"
- alarmSnoozeDuration: 小睡间隔（分钟），枚举值：5,10,15,20,25,30，默认10
- alarmSnoozeTotal: 再响次数，枚举值：0,1,3,5,10，默认0（表示不再响）
- alarmRingDuration: 响铃时长（分钟），枚举值：1,5,10,15,20,30，默认20
- daysOfWakeType: 闹钟响铃类型，枚举值：0=单次响铃，1=法定节假日，2=每天，3=自定义时间，4=法定工作日，默认0
- daysOfWeek: 自定义响铃星期，仅当daysOfWakeType=3（自定义时间）时必需且有效，其他情况不要传递此参数。数组或JSON字符串，枚举值：Mon,Tue,Wed,Thu,Fri,Sat,Sun。注意：仅支持长度为1的数组，如果需要一周中不同的几天，需要多次调用此工具

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      alarmTime: {
        type: "string",
        description: "闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000）",
      },
      alarmTitle: {
        type: "string",
        description: "闹钟名称/标题，默认为'闹钟'",
      },
      alarmSnoozeDuration: {
        type: "number",
        description: "小睡间隔（分钟），枚举值：5,10,15,20,25,30，默认10",
      },
      alarmSnoozeTotal: {
        type: "number",
        description: "再响次数，枚举值：0,1,3,5,10，默认0",
      },
      alarmRingDuration: {
        type: "number",
        description: "响铃时长（分钟），枚举值：1,5,10,15,20,30，默认5",
      },
      daysOfWakeType: {
        type: "number",
        description: "闹钟响铃类型：0=单次，1=法定节假日，2=每天，3=自定义，4=法定工作日，默认0",
      },
      daysOfWeek: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "自定义响铃星期（仅当daysOfWakeType=3时需要，其他情况不要传递），数组或JSON字符串，枚举值：Mon,Tue,Wed,Thu,Fri,Sat,Sun。注意：仅支持长度为1的数组，如果需要一周中不同的几天，需要多次调用此工具",
      },
    },
    required: ["alarmTime"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[CREATE_ALARM_TOOL] 🚀 Starting execution`);
    logger.log(`[CREATE_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[CREATE_ALARM_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[CREATE_ALARM_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== Validate required parameter: alarmTime =====
    if (!params.alarmTime || typeof params.alarmTime !== "string") {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Missing or invalid alarmTime`);
      throw new Error("Missing required parameter: alarmTime must be a string in format YYYYMMDD hhmmss");
    }

    // Parse and convert alarmTime to timestamp
    logger.log(`[CREATE_ALARM_TOOL] 🕒 Parsing alarmTime: ${params.alarmTime}`);
    const alarmTimeMs = parseAlarmTimeToTimestamp(params.alarmTime);

    if (alarmTimeMs === null) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmTime format`);
      throw new Error("Invalid alarmTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 143000)");
    }

    logger.log(`[CREATE_ALARM_TOOL] ✅ alarmTime converted to timestamp: ${alarmTimeMs}`);

    // ===== Validate and set optional parameters with defaults =====

    // alarmTitle - default to "闹钟"
    const alarmTitle = params.alarmTitle && typeof params.alarmTitle === "string"
      ? params.alarmTitle
      : "闹钟";
    logger.log(`[CREATE_ALARM_TOOL]   - alarmTitle: ${alarmTitle}`);

    // alarmSnoozeDuration - default 10
    let alarmSnoozeDuration = 10;
    if (params.alarmSnoozeDuration !== undefined && params.alarmSnoozeDuration !== null) {
      if (typeof params.alarmSnoozeDuration !== "number") {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmSnoozeDuration type`);
        throw new Error("alarmSnoozeDuration must be a number");
      }
      if (!ALARM_SNOOZE_DURATION_VALUES.includes(params.alarmSnoozeDuration)) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmSnoozeDuration value: ${params.alarmSnoozeDuration}`);
        throw new Error(`alarmSnoozeDuration must be one of: ${ALARM_SNOOZE_DURATION_VALUES.join(", ")}`);
      }
      alarmSnoozeDuration = params.alarmSnoozeDuration;
    }
    logger.log(`[CREATE_ALARM_TOOL]   - alarmSnoozeDuration: ${alarmSnoozeDuration}`);

    // alarmSnoozeTotal - default 0
    let alarmSnoozeTotal = 0;
    if (params.alarmSnoozeTotal !== undefined && params.alarmSnoozeTotal !== null) {
      if (typeof params.alarmSnoozeTotal !== "number") {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmSnoozeTotal type`);
        throw new Error("alarmSnoozeTotal must be a number");
      }
      if (!ALARM_SNOOZE_TOTAL_VALUES.includes(params.alarmSnoozeTotal)) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmSnoozeTotal value: ${params.alarmSnoozeTotal}`);
        throw new Error(`alarmSnoozeTotal must be one of: ${ALARM_SNOOZE_TOTAL_VALUES.join(", ")}`);
      }
      alarmSnoozeTotal = params.alarmSnoozeTotal;
    }
    logger.log(`[CREATE_ALARM_TOOL]   - alarmSnoozeTotal: ${alarmSnoozeTotal}`);

    // alarmRingDuration - default 20
    let alarmRingDuration = 20;
    if (params.alarmRingDuration !== undefined && params.alarmRingDuration !== null) {
      if (typeof params.alarmRingDuration !== "number") {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmRingDuration type`);
        throw new Error("alarmRingDuration must be a number");
      }
      if (!ALARM_RING_DURATION_VALUES.includes(params.alarmRingDuration)) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid alarmRingDuration value: ${params.alarmRingDuration}`);
        throw new Error(`alarmRingDuration must be one of: ${ALARM_RING_DURATION_VALUES.join(", ")}`);
      }
      alarmRingDuration = params.alarmRingDuration;
    }
    logger.log(`[CREATE_ALARM_TOOL]   - alarmRingDuration: ${alarmRingDuration}`);

    // daysOfWakeType - default 0
    let daysOfWakeType = 0;
    if (params.daysOfWakeType !== undefined && params.daysOfWakeType !== null) {
      if (typeof params.daysOfWakeType !== "number") {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid daysOfWakeType type`);
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid daysOfWakeType value: ${params.daysOfWakeType}`);
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
      daysOfWakeType = params.daysOfWakeType;
    }
    logger.log(`[CREATE_ALARM_TOOL]   - daysOfWakeType: ${daysOfWakeType}`);

    // daysOfWeek - only required when daysOfWakeType is 3
    let daysOfWeek: string[] = [];
    if (daysOfWakeType === 3) {
      if (!params.daysOfWeek) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Missing daysOfWeek when daysOfWakeType=3`);
        throw new Error("daysOfWeek is required when daysOfWakeType is 3 (custom)");
      }

      // ===== 参数规范化：兼容数组和 JSON 字符串 =====
      let normalizedDaysOfWeek: string[] | null = null;

      // 情况1: 已经是数组
      if (Array.isArray(params.daysOfWeek)) {
        logger.log(`[CREATE_ALARM_TOOL] ✅ daysOfWeek is already an array`);
        normalizedDaysOfWeek = params.daysOfWeek;
      }
      // 情况2: 是字符串，尝试解析为 JSON 数组
      else if (typeof params.daysOfWeek === 'string') {
        logger.log(`[CREATE_ALARM_TOOL] 🔄 daysOfWeek is a string, attempting to parse as JSON...`);
        try {
          const parsed = JSON.parse(params.daysOfWeek);
          if (Array.isArray(parsed)) {
            logger.log(`[CREATE_ALARM_TOOL] ✅ Successfully parsed JSON string to array`);
            normalizedDaysOfWeek = parsed;
          } else {
            logger.error(`[CREATE_ALARM_TOOL] ❌ Parsed JSON is not an array:`, typeof parsed);
            throw new Error("daysOfWeek must be an array or a JSON string representing an array");
          }
        } catch (parseError) {
          logger.error(`[CREATE_ALARM_TOOL] ❌ Failed to parse daysOfWeek as JSON:`, parseError);
          throw new Error(`daysOfWeek must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }
      }
      // 情况3: 其他类型，报错
      else {
        logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid daysOfWeek type:`, typeof params.daysOfWeek);
        throw new Error(`daysOfWeek must be an array or a JSON string, got ${typeof params.daysOfWeek}`);
      }

      // 验证数组非空
      if (!normalizedDaysOfWeek || normalizedDaysOfWeek.length === 0) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ daysOfWeek array is empty`);
        throw new Error("daysOfWeek array cannot be empty");
      }

      // 验证数组长度必须为1
      if (normalizedDaysOfWeek.length !== 1) {
        logger.error(`[CREATE_ALARM_TOOL] ❌ daysOfWeek array length must be 1, got ${normalizedDaysOfWeek.length}`);
        throw new Error("daysOfWeek 仅支持长度为1的数组。如果需要一周中不同的几天，需要多次调用此工具");
      }

      // Validate each day
      for (const day of normalizedDaysOfWeek) {
        if (typeof day !== "string" || !DAYS_OF_WEEK_VALUES.includes(day)) {
          logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid day value: ${day}`);
          throw new Error(`daysOfWeek must contain only: ${DAYS_OF_WEEK_VALUES.join(", ")}`);
        }
      }

      daysOfWeek = normalizedDaysOfWeek;
      logger.log(`[CREATE_ALARM_TOOL]   - daysOfWeek: ${daysOfWeek.join(", ")}`);
    } else {
      // daysOfWakeType is not 3, daysOfWeek should not be provided
      if (params.daysOfWeek) {
        logger.warn(`[CREATE_ALARM_TOOL] ⚠️ daysOfWeek parameter is ignored when daysOfWakeType is not 3 (current: ${daysOfWakeType}). Please remove daysOfWeek parameter.`);
      }
      // Explicitly set to empty array
      daysOfWeek = [];
    }

    // Get session context
    logger.log(`[CREATE_ALARM_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[CREATE_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Create alarm tool can only be used during an active conversation.");
    }

    logger.log(`[CREATE_ALARM_TOOL] ✅ Session context found`);
    logger.log(`[CREATE_ALARM_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[CREATE_ALARM_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[CREATE_ALARM_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[CREATE_ALARM_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[CREATE_ALARM_TOOL] ✅ WebSocket manager obtained`);

    // Build CreateAlarm command
    logger.log(`[CREATE_ALARM_TOOL] 📦 Building CreateAlarm command...`);

    // Build intentParam - only include daysOfWeek when daysOfWakeType is 3
    const intentParam: any = {
      entityName: "Alarm",
      alarmTime: alarmTimeMs,
      alarmTitle: alarmTitle,
      alarmSnoozeDuration: alarmSnoozeDuration,
      alarmSnoozeTotal: alarmSnoozeTotal,
      alarmRingDuration: alarmRingDuration,
      daysOfWakeType: daysOfWakeType,
    };

    // Only include daysOfWeek when daysOfWakeType is 3
    if (daysOfWakeType === 3 && daysOfWeek.length > 0) {
      intentParam.daysOfWeek = daysOfWeek;
      logger.log(`[CREATE_ALARM_TOOL]   - Including daysOfWeek in intentParam: ${daysOfWeek.join(", ")}`);
    } else {
      logger.log(`[CREATE_ALARM_TOOL]   - Excluding daysOfWeek from intentParam (daysOfWakeType=${daysOfWakeType})`);
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
          intentName: "CreateAlarm",
          bundleName: "com.huawei.hmos.clock",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: intentParam,
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
    logger.log(`[CREATE_ALARM_TOOL] ⏳ Setting up promise to wait for alarm creation response...`);
    logger.log(`[CREATE_ALARM_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[CREATE_ALARM_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("创建闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[CREATE_ALARM_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "CreateAlarm") {
          logger.log(`[CREATE_ALARM_TOOL] 🎯 CreateAlarm event received`);
          logger.log(`[CREATE_ALARM_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[CREATE_ALARM_TOOL] ✅ Alarm creation completed successfully`);
            logger.log(`[CREATE_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[CREATE_ALARM_TOOL] ❌ Device returned error`);
              logger.error(`[CREATE_ALARM_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[CREATE_ALARM_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`创建闹钟失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result with safe navigation
            const result = event.outputs.result || {};
            logger.log(`[CREATE_ALARM_TOOL] 📋 Alarm result:`, JSON.stringify(result));

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    alarm: {
                      entityId: result.entityId,
                      entityName: result.entityName,
                      alarmTitle: result.alarmTitle,
                      alarmTime: result.alarmTime,
                      alarmState: result.alarmState,
                      alarmRingDuration: result.alarmRingDuration,
                      alarmSnoozeDuration: result.alarmSnoozeDuration,
                      alarmSnoozeTotal: result.alarmSnoozeTotal,
                      daysOfWakeType: result.daysOfWakeType,
                    },
                    code,
                  }),
                },
              ],
            });
          } else {
            logger.error(`[CREATE_ALARM_TOOL] ❌ Alarm creation failed`);
            logger.error(`[CREATE_ALARM_TOOL]   - status: ${event.status}`);
            logger.error(`[CREATE_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));
            reject(new Error(`创建闹钟失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[CREATE_ALARM_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[CREATE_ALARM_TOOL] 📤 Sending CreateAlarm command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[CREATE_ALARM_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[CREATE_ALARM_TOOL] ❌ Failed to send command:`, error);
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
      logger.error(`[CREATE_ALARM_TOOL] ❌ alarmTime too short: ${trimmed}`);
      return null;
    }

    // Extract date and time parts
    // Format: YYYYMMDD hhmmss
    const datePart = trimmed.substring(0, 8); // YYYYMMDD
    const timePart = trimmed.substring(8).trim(); // hhmmss (may have leading space)

    logger.log(`[CREATE_ALARM_TOOL]   - datePart: ${datePart}, timePart: ${timePart}`);

    // Validate lengths
    if (datePart.length !== 8 || timePart.length !== 6) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid part lengths: datePart=${datePart.length}, timePart=${timePart.length}`);
      return null;
    }

    // Parse components
    const year = parseInt(datePart.substring(0, 4), 10);
    const month = parseInt(datePart.substring(4, 6), 10);
    const day = parseInt(datePart.substring(6, 8), 10);
    const hour = parseInt(timePart.substring(0, 2), 10);
    const minute = parseInt(timePart.substring(2, 4), 10);
    const second = parseInt(timePart.substring(4, 6), 10);

    logger.log(`[CREATE_ALARM_TOOL]   - Parsed: ${year}-${month}-${day} ${hour}:${minute}:${second}`);

    // Validate values
    if (isNaN(year) || isNaN(month) || isNaN(day) ||
        isNaN(hour) || isNaN(minute) || isNaN(second)) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ NaN detected in parsed values`);
      return null;
    }

    // Validate ranges
    if (month < 1 || month > 12) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid month: ${month}`);
      return null;
    }
    if (day < 1 || day > 31) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid day: ${day}`);
      return null;
    }
    if (hour < 0 || hour > 23) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid hour: ${hour}`);
      return null;
    }
    if (minute < 0 || minute > 59) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid minute: ${minute}`);
      return null;
    }
    if (second < 0 || second > 59) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Invalid second: ${second}`);
      return null;
    }

    // Create Date object and get timestamp
    const date = new Date(year, month - 1, day, hour, minute, second);
    const timestamp = date.getTime();

    if (isNaN(timestamp)) {
      logger.error(`[CREATE_ALARM_TOOL] ❌ Generated timestamp is NaN`);
      return null;
    }

    return timestamp;
  } catch (error) {
    logger.error(`[CREATE_ALARM_TOOL] ❌ Exception in parseAlarmTimeToTimestamp:`, error);
    return null;
  }
}
