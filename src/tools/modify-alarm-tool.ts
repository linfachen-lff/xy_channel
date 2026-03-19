// Modify Alarm tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

// Enum definitions for alarm parameters (same as create-alarm-tool)
const ALARM_SNOOZE_DURATION_VALUES = [5, 10, 15, 20, 25, 30];
const ALARM_SNOOZE_TOTAL_VALUES = [0, 1, 3, 5, 10];
const ALARM_RING_DURATION_VALUES = [1, 5, 10, 15, 20, 30];
const DAYS_OF_WAKE_TYPE_VALUES = [0, 1, 2, 3, 4];
const DAYS_OF_WEEK_VALUES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * XY modify alarm tool - modifies an existing alarm on user's device.
 * Requires entityId from search_alarm or create_alarm tool.
 *
 * Prerequisites:
 * 1. Call search_alarm or create_alarm tool first to get entityId
 * 2. Use the entityId to identify which alarm to modify
 */
export const modifyAlarmTool: any = {
  name: "modify_alarm",
  label: "Modify Alarm",
  description: `修改用户设备上已存在的闹钟。

必需参数：
- entityId: 闹钟的唯一标识符，必须先通过 search_alarm 或 create_alarm 工具获取

可选参数（与创建闹钟的参数完全一致）：
- alarmTime: 闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000）
- alarmTitle: 闹钟名称/标题
- alarmState: 闹钟开启状态，0=关闭，1=开启
- alarmSnoozeDuration: 小睡间隔（分钟），枚举值：5,10,15,20,25,30
- alarmSnoozeTotal: 再响次数，枚举值：0,1,3,5,10
- alarmRingDuration: 响铃时长（分钟），枚举值：1,5,10,15,20,30
- daysOfWakeType: 闹钟响铃类型，枚举值：0=单次，1=法定节假日，2=每天，3=自定义，4=法定工作日
- daysOfWeek: 自定义响铃星期，仅当daysOfWakeType=3（自定义时间）时必需且有效，其他情况不要传递此参数。数组或JSON字符串，枚举值：Mon,Tue,Wed,Thu,Fri,Sat,Sun。注意：仅支持长度为1的数组，如果需要一周中不同的几天，需要多次调用此工具

使用流程：
1. 先调用 search_alarm 工具查询闹钟，获取 entityId
2. 调用此工具修改闹钟，传入 entityId 和需要修改的参数

注意事项：操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。`,
  parameters: {
    type: "object",
    properties: {
      entityId: {
        type: "string",
        description: "闹钟的唯一标识符，必须先通过 search_alarm 或 create_alarm 工具获取",
      },
      alarmTime: {
        type: "string",
        description: "闹钟时间，格式必须为：YYYYMMDD hhmmss（例如：20240315 143000）",
      },
      alarmTitle: {
        type: "string",
        description: "闹钟名称/标题",
      },
      alarmState: {
        type: "number",
        description: "闹钟开启状态：0=关闭，1=开启",
      },
      alarmSnoozeDuration: {
        type: "number",
        description: "小睡间隔（分钟），枚举值：5,10,15,20,25,30",
      },
      alarmSnoozeTotal: {
        type: "number",
        description: "再响次数，枚举值：0,1,3,5,10",
      },
      alarmRingDuration: {
        type: "number",
        description: "响铃时长（分钟），枚举值：1,5,10,15,20,30",
      },
      daysOfWakeType: {
        type: "number",
        description: "闹钟响铃类型：0=单次，1=法定节假日，2=每天，3=自定义，4=法定工作日",
      },
      daysOfWeek: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "自定义响铃星期（仅当daysOfWakeType=3时需要，其他情况不要传递），数组或JSON字符串，枚举值：Mon,Tue,Wed,Thu,Fri,Sat,Sun。注意：仅支持长度为1的数组，如果需要一周中不同的几天，需要多次调用此工具",
      },
    },
    required: ["entityId"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[MODIFY_ALARM_TOOL] 🚀 Starting execution`);
    logger.log(`[MODIFY_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[MODIFY_ALARM_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[MODIFY_ALARM_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== Validate required parameter: entityId =====
    if (!params.entityId || typeof params.entityId !== "string") {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Missing or invalid entityId`);
      throw new Error("Missing required parameter: entityId must be a string obtained from search_alarm or create_alarm");
    }

    logger.log(`[MODIFY_ALARM_TOOL]   - entityId: ${params.entityId}`);

    // ===== Build intentParam with provided parameters =====
    const intentParam: any = {
      entityName: "Alarm",
      entityId: params.entityId,
    };

    // Parse and convert alarmTime if provided
    if (params.alarmTime !== undefined && params.alarmTime !== null) {
      if (typeof params.alarmTime !== "string") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmTime type`);
        throw new Error("alarmTime must be a string in format YYYYMMDD hhmmss");
      }

      logger.log(`[MODIFY_ALARM_TOOL] 🕒 Parsing alarmTime: ${params.alarmTime}`);
      const alarmTimeMs = parseAlarmTimeToTimestamp(params.alarmTime);

      if (alarmTimeMs === null) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmTime format`);
        throw new Error("Invalid alarmTime format. Required format: YYYYMMDD hhmmss (e.g., 20240315 143000)");
      }

      intentParam.alarmTime = alarmTimeMs;
      logger.log(`[MODIFY_ALARM_TOOL] ✅ alarmTime converted to timestamp: ${alarmTimeMs}`);
    }

    // Add alarmTitle if provided
    if (params.alarmTitle !== undefined && params.alarmTitle !== null) {
      if (typeof params.alarmTitle !== "string") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmTitle type`);
        throw new Error("alarmTitle must be a string");
      }
      intentParam.alarmTitle = params.alarmTitle;
      logger.log(`[MODIFY_ALARM_TOOL]   - alarmTitle: ${params.alarmTitle}`);
    }

    // Add alarmState if provided
    if (params.alarmState !== undefined && params.alarmState !== null) {
      if (typeof params.alarmState !== "number") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmState type`);
        throw new Error("alarmState must be a number");
      }
      if (!ALARM_STATE_VALUES.includes(params.alarmState)) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmState value: ${params.alarmState}`);
        throw new Error(`alarmState must be one of: ${ALARM_STATE_VALUES.join(", ")}`);
      }
      intentParam.alarmState = params.alarmState;
      logger.log(`[MODIFY_ALARM_TOOL]   - alarmState: ${params.alarmState}`);
    }

    // Add alarmSnoozeDuration if provided
    if (params.alarmSnoozeDuration !== undefined && params.alarmSnoozeDuration !== null) {
      if (typeof params.alarmSnoozeDuration !== "number") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmSnoozeDuration type`);
        throw new Error("alarmSnoozeDuration must be a number");
      }
      if (!ALARM_SNOOZE_DURATION_VALUES.includes(params.alarmSnoozeDuration)) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmSnoozeDuration value: ${params.alarmSnoozeDuration}`);
        throw new Error(`alarmSnoozeDuration must be one of: ${ALARM_SNOOZE_DURATION_VALUES.join(", ")}`);
      }
      intentParam.alarmSnoozeDuration = params.alarmSnoozeDuration;
      logger.log(`[MODIFY_ALARM_TOOL]   - alarmSnoozeDuration: ${params.alarmSnoozeDuration}`);
    }

    // Add alarmSnoozeTotal if provided
    if (params.alarmSnoozeTotal !== undefined && params.alarmSnoozeTotal !== null) {
      if (typeof params.alarmSnoozeTotal !== "number") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmSnoozeTotal type`);
        throw new Error("alarmSnoozeTotal must be a number");
      }
      if (!ALARM_SNOOZE_TOTAL_VALUES.includes(params.alarmSnoozeTotal)) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmSnoozeTotal value: ${params.alarmSnoozeTotal}`);
        throw new Error(`alarmSnoozeTotal must be one of: ${ALARM_SNOOZE_TOTAL_VALUES.join(", ")}`);
      }
      intentParam.alarmSnoozeTotal = params.alarmSnoozeTotal;
      logger.log(`[MODIFY_ALARM_TOOL]   - alarmSnoozeTotal: ${params.alarmSnoozeTotal}`);
    }

    // Add alarmRingDuration if provided
    if (params.alarmRingDuration !== undefined && params.alarmRingDuration !== null) {
      if (typeof params.alarmRingDuration !== "number") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmRingDuration type`);
        throw new Error("alarmRingDuration must be a number");
      }
      if (!ALARM_RING_DURATION_VALUES.includes(params.alarmRingDuration)) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid alarmRingDuration value: ${params.alarmRingDuration}`);
        throw new Error(`alarmRingDuration must be one of: ${ALARM_RING_DURATION_VALUES.join(", ")}`);
      }
      intentParam.alarmRingDuration = params.alarmRingDuration;
      logger.log(`[MODIFY_ALARM_TOOL]   - alarmRingDuration: ${params.alarmRingDuration}`);
    }

    // Add daysOfWakeType if provided
    if (params.daysOfWakeType !== undefined && params.daysOfWakeType !== null) {
      if (typeof params.daysOfWakeType !== "number") {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid daysOfWakeType type`);
        throw new Error("daysOfWakeType must be a number");
      }
      if (!DAYS_OF_WAKE_TYPE_VALUES.includes(params.daysOfWakeType)) {
        logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid daysOfWakeType value: ${params.daysOfWakeType}`);
        throw new Error(`daysOfWakeType must be one of: ${DAYS_OF_WAKE_TYPE_VALUES.join(", ")}`);
      }
      intentParam.daysOfWakeType = params.daysOfWakeType;
      logger.log(`[MODIFY_ALARM_TOOL]   - daysOfWakeType: ${params.daysOfWakeType}`);
    }

    // Add daysOfWeek if provided - only valid when daysOfWakeType is 3
    if (params.daysOfWeek !== undefined && params.daysOfWeek !== null) {
      // Check if daysOfWakeType is 3 or will be set to 3
      const targetDaysOfWakeType = params.daysOfWakeType !== undefined ? params.daysOfWakeType : null;

      if (targetDaysOfWakeType !== null && targetDaysOfWakeType !== 3) {
        logger.warn(`[MODIFY_ALARM_TOOL] ⚠️ daysOfWeek parameter is ignored when daysOfWakeType is not 3 (current: ${targetDaysOfWakeType}). Please remove daysOfWeek parameter.`);
        // Skip processing daysOfWeek when daysOfWakeType is not 3
      } else {
        // ===== 参数规范化：兼容数组和 JSON 字符串 =====
        let normalizedDaysOfWeek: string[] | null = null;

        // 情况1: 已经是数组
        if (Array.isArray(params.daysOfWeek)) {
          logger.log(`[MODIFY_ALARM_TOOL] ✅ daysOfWeek is already an array`);
          normalizedDaysOfWeek = params.daysOfWeek;
        }
        // 情况2: 是字符串，尝试解析为 JSON 数组
        else if (typeof params.daysOfWeek === 'string') {
          logger.log(`[MODIFY_ALARM_TOOL] 🔄 daysOfWeek is a string, attempting to parse as JSON...`);
          try {
            const parsed = JSON.parse(params.daysOfWeek);
            if (Array.isArray(parsed)) {
              logger.log(`[MODIFY_ALARM_TOOL] ✅ Successfully parsed JSON string to array`);
              normalizedDaysOfWeek = parsed;
            } else {
              logger.error(`[MODIFY_ALARM_TOOL] ❌ Parsed JSON is not an array:`, typeof parsed);
              throw new Error("daysOfWeek must be an array or a JSON string representing an array");
            }
          } catch (parseError) {
            logger.error(`[MODIFY_ALARM_TOOL] ❌ Failed to parse daysOfWeek as JSON:`, parseError);
            throw new Error(`daysOfWeek must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          }
        }
        // 情况3: 其他类型，报错
        else {
          logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid daysOfWeek type:`, typeof params.daysOfWeek);
          throw new Error(`daysOfWeek must be an array or a JSON string, got ${typeof params.daysOfWeek}`);
        }

        // 验证数组非空
        if (!normalizedDaysOfWeek || normalizedDaysOfWeek.length === 0) {
          logger.error(`[MODIFY_ALARM_TOOL] ❌ daysOfWeek array is empty`);
          throw new Error("daysOfWeek array cannot be empty");
        }

        // 验证数组长度必须为1
        if (normalizedDaysOfWeek.length !== 1) {
          logger.error(`[MODIFY_ALARM_TOOL] ❌ daysOfWeek array length must be 1, got ${normalizedDaysOfWeek.length}`);
          throw new Error("daysOfWeek 仅支持长度为1的数组。如果需要一周中不同的几天，需要多次调用此工具");
        }

        // Validate each day
        for (const day of normalizedDaysOfWeek) {
          if (typeof day !== "string" || !DAYS_OF_WEEK_VALUES.includes(day)) {
            logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid day value: ${day}`);
            throw new Error(`daysOfWeek must contain only: ${DAYS_OF_WEEK_VALUES.join(", ")}`);
          }
        }

        intentParam.daysOfWeek = normalizedDaysOfWeek;
        logger.log(`[MODIFY_ALARM_TOOL]   - daysOfWeek: ${normalizedDaysOfWeek.join(", ")}`);
      }
    }

    // Get session context
    logger.log(`[MODIFY_ALARM_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[MODIFY_ALARM_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Modify alarm tool can only be used during an active conversation.");
    }

    logger.log(`[MODIFY_ALARM_TOOL] ✅ Session context found`);
    logger.log(`[MODIFY_ALARM_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[MODIFY_ALARM_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[MODIFY_ALARM_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[MODIFY_ALARM_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[MODIFY_ALARM_TOOL] ✅ WebSocket manager obtained`);

    // Build ModifyAlarm command
    logger.log(`[MODIFY_ALARM_TOOL] 📦 Building ModifyAlarm command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "ModifyAlarm",
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
    logger.log(`[MODIFY_ALARM_TOOL] ⏳ Setting up promise to wait for alarm modification response...`);
    logger.log(`[MODIFY_ALARM_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[MODIFY_ALARM_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("修改闹钟超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[MODIFY_ALARM_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "ModifyAlarm") {
          logger.log(`[MODIFY_ALARM_TOOL] 🎯 ModifyAlarm event received`);
          logger.log(`[MODIFY_ALARM_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[MODIFY_ALARM_TOOL] ✅ Alarm modification completed successfully`);
            logger.log(`[MODIFY_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[MODIFY_ALARM_TOOL] ❌ Device returned error`);
              logger.error(`[MODIFY_ALARM_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[MODIFY_ALARM_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`修改闹钟失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Extract result with safe navigation
            const result = event.outputs.result || {};
            logger.log(`[MODIFY_ALARM_TOOL] 📋 Alarm result:`, JSON.stringify(result));

            // Build response with safe navigation
            const response: any = {
              success: true,
              alarm: {
                entityId: result.entityId || params.entityId,
                entityType: result.entityType || result.entityName,
                alarmTitle: result.alarmTitle,
                alarmTime: result.alarmTime,
                alarmState: result.alarmState,
                alarmRingDuration: result.alarmRingDuration,
                alarmSnoozeDuration: result.alarmSnoozeDuration,
                alarmSnoozeTotal: result.alarmSnoozeTotal,
                daysOfWakeType: result.daysOfWakeType,
              },
              code,
            };

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response),
                },
              ],
            });
          } else {
            logger.error(`[MODIFY_ALARM_TOOL] ❌ Alarm modification failed`);
            logger.error(`[MODIFY_ALARM_TOOL]   - status: ${event.status}`);
            logger.error(`[MODIFY_ALARM_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));
            reject(new Error(`修改闹钟失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      logger.log(`[MODIFY_ALARM_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[MODIFY_ALARM_TOOL] 📤 Sending ModifyAlarm command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[MODIFY_ALARM_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[MODIFY_ALARM_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};

// Enum for alarm state
const ALARM_STATE_VALUES = [0, 1];

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
      logger.error(`[MODIFY_ALARM_TOOL] ❌ alarmTime too short: ${trimmed}`);
      return null;
    }

    // Extract date and time parts
    // Format: YYYYMMDD hhmmss
    const datePart = trimmed.substring(0, 8); // YYYYMMDD
    const timePart = trimmed.substring(8).trim(); // hhmmss (may have leading space)

    logger.log(`[MODIFY_ALARM_TOOL]   - datePart: ${datePart}, timePart: ${timePart}`);

    // Validate lengths
    if (datePart.length !== 8 || timePart.length !== 6) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid part lengths: datePart=${datePart.length}, timePart=${timePart.length}`);
      return null;
    }

    // Parse components
    const year = parseInt(datePart.substring(0, 4), 10);
    const month = parseInt(datePart.substring(4, 6), 10);
    const day = parseInt(datePart.substring(6, 8), 10);
    const hour = parseInt(timePart.substring(0, 2), 10);
    const minute = parseInt(timePart.substring(2, 4), 10);
    const second = parseInt(timePart.substring(4, 6), 10);

    logger.log(`[MODIFY_ALARM_TOOL]   - Parsed: ${year}-${month}-${day} ${hour}:${minute}:${second}`);

    // Validate values
    if (isNaN(year) || isNaN(month) || isNaN(day) ||
        isNaN(hour) || isNaN(minute) || isNaN(second)) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ NaN detected in parsed values`);
      return null;
    }

    // Validate ranges
    if (month < 1 || month > 12) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid month: ${month}`);
      return null;
    }
    if (day < 1 || day > 31) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid day: ${day}`);
      return null;
    }
    if (hour < 0 || hour > 23) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid hour: ${hour}`);
      return null;
    }
    if (minute < 0 || minute > 59) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid minute: ${minute}`);
      return null;
    }
    if (second < 0 || second > 59) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Invalid second: ${second}`);
      return null;
    }

    // Create Date object and get timestamp
    const date = new Date(year, month - 1, day, hour, minute, second);
    const timestamp = date.getTime();

    if (isNaN(timestamp)) {
      logger.error(`[MODIFY_ALARM_TOOL] ❌ Generated timestamp is NaN`);
      return null;
    }

    return timestamp;
  } catch (error) {
    logger.error(`[MODIFY_ALARM_TOOL] ❌ Exception in parseAlarmTimeToTimestamp:`, error);
    return null;
  }
}
