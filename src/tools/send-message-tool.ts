// Send Message tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY send message tool - sends SMS message on user's device.
 * Requires phoneNumber (with +86 prefix) and content parameters.
 */
export const sendMessageTool: any = {
  name: "send_message",
  label: "Send Message",
  description: "通过手机发送短信。需要提供接收方手机号码和短信内容。手机号码会自动添加+86前缀（如果没有的话）。注意:操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      phoneNumber: {
        type: "string",
        description: "接收方手机号码（会自动添加+86前缀）",
      },
      content: {
        type: "string",
        description: "短信内容",
      },
    },
    required: ["phoneNumber", "content"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEND_MESSAGE_TOOL] 🚀 Starting execution`);
    logger.log(`[SEND_MESSAGE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEND_MESSAGE_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEND_MESSAGE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate phoneNumber parameter
    if (!params.phoneNumber || typeof params.phoneNumber !== "string" || params.phoneNumber.trim() === "") {
      logger.error(`[SEND_MESSAGE_TOOL] ❌ Missing or invalid phoneNumber parameter`);
      throw new Error("Missing required parameter: phoneNumber must be a non-empty string");
    }

    // Validate content parameter
    if (!params.content || typeof params.content !== "string" || params.content.trim() === "") {
      logger.error(`[SEND_MESSAGE_TOOL] ❌ Missing or invalid content parameter`);
      throw new Error("Missing required parameter: content must be a non-empty string");
    }

    // Normalize phone number: add +86 prefix if not present
    let phoneNumber = params.phoneNumber.trim();
    if (!phoneNumber.startsWith("+86")) {
      // Remove leading 0 if present (e.g., 086 -> 86)
      if (phoneNumber.startsWith("0")) {
        phoneNumber = phoneNumber.substring(1);
      }
      // Remove +86 or 86 prefix if already present to avoid duplication
      if (phoneNumber.startsWith("86")) {
        phoneNumber = phoneNumber.substring(2);
      }
      phoneNumber = `+86${phoneNumber}`;
      logger.log(`[SEND_MESSAGE_TOOL] 📞 Normalized phone number: ${params.phoneNumber} -> ${phoneNumber}`);
    }

    logger.log(`[SEND_MESSAGE_TOOL] 📤 Preparing to send message`);
    logger.log(`[SEND_MESSAGE_TOOL]   - phoneNumber: ${phoneNumber}`);
    logger.log(`[SEND_MESSAGE_TOOL]   - content length: ${params.content.length} characters`);

    // Get session context
    logger.log(`[SEND_MESSAGE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[SEND_MESSAGE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEND_MESSAGE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Send message tool can only be used during an active conversation.");
    }

    logger.log(`[SEND_MESSAGE_TOOL] ✅ Session context found`);
    logger.log(`[SEND_MESSAGE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEND_MESSAGE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEND_MESSAGE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEND_MESSAGE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEND_MESSAGE_TOOL] ✅ WebSocket manager obtained`);

    // Build SendShortMessage command
    logger.log(`[SEND_MESSAGE_TOOL] 📦 Building SendShortMessage command...`);
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "SendShortMessage",
          bundleName: "com.huawei.hmos.aidispatchservice",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam: {
            phoneNumber: phoneNumber,
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

    logger.log(`[SEND_MESSAGE_TOOL] 📋 Command details:`, JSON.stringify(command, null, 2));

    // Send command and wait for response (60 second timeout)
    logger.log(`[SEND_MESSAGE_TOOL] ⏳ Setting up promise to wait for send message response...`);
    logger.log(`[SEND_MESSAGE_TOOL]   - Timeout: 60 seconds`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error(`[SEND_MESSAGE_TOOL] ⏰ Timeout: No response received within 60 seconds`);
        wsManager.off("data-event", handler);
        reject(new Error("发送短信超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {
        logger.log(`[SEND_MESSAGE_TOOL] 📨 Received data event:`, JSON.stringify(event));

        if (event.intentName === "SendShortMessage") {
          logger.log(`[SEND_MESSAGE_TOOL] 🎯 SendShortMessage event received`);
          logger.log(`[SEND_MESSAGE_TOOL]   - status: ${event.status}`);

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {
            logger.log(`[SEND_MESSAGE_TOOL] ✅ Message sent successfully`);
            logger.log(`[SEND_MESSAGE_TOOL]   - phoneNumber: ${phoneNumber}`);
            logger.log(`[SEND_MESSAGE_TOOL]   - outputs:`, JSON.stringify(event.outputs));

            // 成功，直接返回完整的 event.outputs JSON 字符串
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            logger.error(`[SEND_MESSAGE_TOOL] ❌ Send message failed`);
            logger.error(`[SEND_MESSAGE_TOOL]   - status: ${event.status}`);
            logger.error(`[SEND_MESSAGE_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));

            const errorDetail = event.outputs ? JSON.stringify(event.outputs) : event.status;
            reject(new Error(`发送短信失败: ${errorDetail}`));
          }
        }
      };

      // Register event handler
      logger.log(`[SEND_MESSAGE_TOOL] 📡 Registering data-event handler on WebSocket manager`);
      wsManager.on("data-event", handler);

      // Send the command
      logger.log(`[SEND_MESSAGE_TOOL] 📤 Sending SendShortMessage command...`);
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
          logger.log(`[SEND_MESSAGE_TOOL] ✅ Command sent successfully, waiting for response...`);
        })
        .catch((error) => {
          logger.error(`[SEND_MESSAGE_TOOL] ❌ Failed to send command:`, error);
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
