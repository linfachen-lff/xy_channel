// XiaoYi Add Collection tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * Duck-typed ToolInputError: openclaw 按 .name 字段匹配，不用 instanceof。
 * 抛出此错误会让 openclaw 返回 HTTP 400 而非 500，
 * LLM 会将其识别为参数错误而非瞬时故障，不会触发重试。
 */
class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * XY add collection tool - adds data to user's XiaoYi collection.
 */
export const xiaoyiAddCollectionTool: any = {
  name: "AddCollection",
  label: "Add XiaoYi Collection",
  description: `向小艺收藏中添加公共知识数据，可以给用户提供个性化体验。用户希望保存到个人化知识库中的数据都可以调用本技能。不同类型的数据对应的数据要求如下：
  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "必填字段（HYPER_LINK/TEXT类型时）。用户添加收藏的链接url或文本原文。",
      },
      uri: {
        type: "string",
        description: "必填字段（IMAGE/FILE类型时）。图片或文件的端存储地址链接。",
      },
      sourceAppBundleName: {
        type: "string",
        description: "非必填字段。标识该数据的来源应用。",
      },
      dataType: {
        type: "string",
        description: "必填字段。标识数据类型：HYPER_LINK表示网页（注意：如果收藏的图片或者文件是超链接（http或者https开头），无论是图片还是文件，都使用HYPER_LINK），TEXT表示文本，IMAGE表示图片，FILE表示文件。IMAGE和FILE类型都只支持手机本地地址（file://开头，当前手机本地文件路径仅能通过search_photo_gallery或者QueryCollection或者search_file结果中获取，不要拼凑生成）",
      },
    },
    required: ["dataType"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    const { content, uri, sourceAppBundleName, dataType } = params;

    const validTypes = ["HYPER_LINK", "TEXT", "IMAGE", "FILE"];
    if (!dataType || !validTypes.includes(dataType)) {
      throw new ToolInputError(`dataType必填且必须为 HYPER_LINK、TEXT、IMAGE、FILE 之一，当前值: ${dataType}`);
    }

    if ((dataType === "HYPER_LINK" || dataType === "TEXT") && (!content || typeof content !== "string")) {
      throw new ToolInputError(`dataType为${dataType}时，content字段必填且不能为空`);
    }

    if ((dataType === "IMAGE" || dataType === "FILE") && (!uri || typeof uri !== "string")) {
      throw new ToolInputError(`dataType为${dataType}时，uri字段必填且不能为空`);
    }

    // Get session context
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      throw new Error("No active XY session found. AddCollection tool can only be used during an active conversation.");
    }

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Build intentParam
    const intentParam: Record<string, string> = {
      dataType,
    };

    if (content) {
      intentParam.content = content;
    }
    if (uri) {
      intentParam.uri = uri;
    }
    if (sourceAppBundleName) {
      intentParam.sourceAppBundleName = sourceAppBundleName;
    }

    // Build AddCollection command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "AddCollection",
          bundleName: "com.huawei.hmos.vassistant",
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("添加小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "AddCollection") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            reject(new Error(`添加小艺收藏失败: ${event.status}`));
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
