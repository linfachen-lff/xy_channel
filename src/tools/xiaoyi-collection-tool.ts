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

    // Get session context
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      throw new Error("No active XY session found. XiaoYi collection tool can only be used during an active conversation.");
    }


    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build QueryCollection command
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("查询小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "QueryCollection") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

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
            reject(new Error(`查询小艺收藏失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      wsManager.on("data-event", handler);

      // Send the command
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
        })
        .catch((error) => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
