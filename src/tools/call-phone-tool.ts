// Call Phone tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY call phone tool - makes a phone call on user's device.
 * Requires phoneNumber parameter and optional slotId (0 for primary SIM, 1 for secondary SIM).
 */
export const callPhoneTool: any = {
  name: "call_phone",
  label: "Call Phone",
  description: "拨打电话。需要提供要拨打的电话号码。slotId参数可选，默认为0（主卡），如果用户明确要求使用副卡则设置为1。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      phoneNumber: {
        type: "string",
        description: "要拨打的电话号码",
      },
      slotId: {
        type: "number",
        description: "SIM卡槽ID，默认为0（主卡），设置为1表示副卡。仅当用户明确要求使用副卡时才设置为1",
        default: 0,
      },
    },
    required: ["phoneNumber"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[CALL_PHONE_TOOL] 🚀 Starting execution`);
    logger.log(`[CALL_PHONE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[CALL_PHONE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[CALL_PHONE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate phoneNumber parameter
    if (!params.phoneNumber || typeof params.phoneNumber !== "string" || params.phoneNumber.trim() === "") {
      logger.error(`[CALL_PHONE_TOOL] ❌ Missing or invalid phoneNumber parameter`);
      throw new Error("Missing required parameter: phoneNumber must be a non-empty string");
    }

    // Set default slotId if not provided
    const slotId = params.slotId !== undefined && params.slotId !== null ? params.slotId : 0;

    // Validate slotId (must be 0 or 1)
    if (slotId !== 0 && slotId !== 1) {
      logger.error(`[CALL_PHONE_TOOL] ❌ Invalid slotId: ${slotId}`);
      throw new Error("Invalid slotId: must be 0 (primary SIM) or 1 (secondary SIM)");
    }

    logger.log(`[CALL_PHONE_TOOL] 📞 Preparing to call phone number: ${params.phoneNumber}`);
    logger.log(`[CALL_PHONE_TOOL]   - slotId: ${slotId} (${slotId === 0 ? "主卡" : "副卡"})`);

    // Get session context
    logger.log(`[CALL_PHONE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[CALL_PHONE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[CALL_PHONE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Call phone tool can only be used during an active conversation.");
    }

    logger.log(`[CALL_PHONE_TOOL] ✅ Session context found`);
    logger.log(`[CALL_PHONE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[CALL_PHONE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[CALL_PHONE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[CALL_PHONE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[CALL_PHONE_TOOL] ✅ WebSocket manager obtained`);

    // Build StartCall command
    logger.log(`[CALL_PHONE_TOOL] 📦 Building StartCall command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "StartCall",
          bundleName: "com.huawei.hmos.aidispatchservice",
          dimension: "",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            phoneNumber: params.phoneNumber.trim(),
            slotId: slotId,
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

    logger.log(`[CALL_PHONE_TOOL] 📋 Command details:`, JSON.stringify(command, null, 2));

    // Send command and wait for response (60 second timeout)
    logger.log(`[CALL_PHONE_TOOL] ⏳ Setting up promise to wait for call response...`);
    logger.log(`[CALL_PHONE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[CALL_PHONE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("拨打电话超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[CALL_PHONE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "StartCall") {
          logger.log(`[CALL_PHONE_TOOL] 🎯 StartCall event received`);
          logger.log(`[CALL_PHONE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[CALL_PHONE_TOOL] ✅ Call response received`);
            logger.log(`[CALL_PHONE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // Check for error code in outputs
            const code = event.outputs.code !== undefined ? event.outputs.code : null;

            if (code !== null && code !== 0) {
              logger.error(`[CALL_PHONE_TOOL] ❌ Device returned error`);
              logger.error(`[CALL_PHONE_TOOL]   - code: ${code}`);
              const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
              logger.error(`[CALL_PHONE_TOOL]   - errorMsg: ${errorMsg}`);
              reject(new Error(`拨打电话失败: ${errorMsg} (错误代码: ${code})`));
              return;
            }

            // Return the outputs directly
            const result = {
              success: true,
              code: code,
              phoneNumber: params.phoneNumber,
              slotId: slotId,
              message: "电话拨打成功",
            };

            logger.log(`[CALL_PHONE_TOOL] 🎉 Call initiated successfully`);
            logger.log(`[CALL_PHONE_TOOL]   - phoneNumber: ${params.phoneNumber}`);
            logger.log(`[CALL_PHONE_TOOL]   - slotId: ${slotId}`);

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            });
          } else {
            logger.error(`[CALL_PHONE_TOOL] ❌ Call failed`);
            logger.error(`[CALL_PHONE_TOOL]   - status: ${event.status}`);
            logger.error(`[CALL_PHONE_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`拨打电话失败: ${errorDetail}`));
          }
        }
      };

      // Register event handler
      logger.log(`[CALL_PHONE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[CALL_PHONE_TOOL] 📤 Sending StartCall command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[CALL_PHONE_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[CALL_PHONE_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
