// Send Command To Car tool implementation
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";

/**
 * Send command to car (小艺车机) tool - sends an output command to the car's Xiaoyi system.
 * The command will be received and executed on the car's Xiaoyi device.
 */
export const sendCommandToCarTool: any = {
  name: "send_command_to_car",
  label: "Send Command To Car",
  description: "将输出指令发送给小艺车机，车机小艺会接收并执行该指令。注意:请勿重复调用此工具,如果超时或失败,最多重试一次。回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案。",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要发送给车机的指令内容（对应intentParam中的out字段）",
      },
    },
    required: ["command"],
  },

  async execute(toolCallId: string, params: any) {
    // Validate command parameter
    if (!params.command || typeof params.command !== "string" || params.command.trim() === "") {
      throw new Error("Missing required parameter: command must be a non-empty string");
    }

    // Get session context
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      throw new Error("No active XY session found. Send command to car tool can only be used during an active conversation.");
    }

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Build PlayStoryBook command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          achieveType: "INTENT",
          actionResponse: true,
          bundleName: "com.huawei.vassistantcar",
          dimension: "",
          executeMode: "background",
          intentName: "PlayStoryBook",
          intentParam: {
            out: params.command,
          },
          needUnlock: true,
          permissionId: [],
          timeOut: 5,
        },
        needUploadResult: true,
        pageControlRelated: false,
        responses: [
          {
            displayText: "",
            resultCode: "",
            ttsText: "",
          },
        ],
      },
    };

    // Send command - fire and forget, return success once sent
    await sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    });

    logger.log("[sendCommandToCar] command sent to car successfully");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, message: "指令已成功下发给车机" }),
        },
      ],
    };
  },
};
