// Search Photo Gallery tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search photo gallery tool - searches photos in user's gallery.
 * Returns local mediaUri strings that can be used with upload_photo tool.
 *
 * IMPORTANT: The returned mediaUris are LOCAL URIs that cannot be downloaded directly.
 * To get publicly accessible URLs, use the upload_photo tool with these URIs.
 */
export const searchPhotoGalleryTool: any = {
  name: "search_photo_gallery",
  label: "Search Photo Gallery",
  description: `插件功能描述：搜索用户手机图库中的照片
  工具使用约束：如果用户说从手机图库中或者从相册中查询xx图片时调用此工具。
  工具输入输出简介：
  a. 根据图像描述语料检索匹配的照片,返回照片在手机本地的 mediaUri以及thumbnailUri。
  b. 返回的 mediaUri以及thumbnailUri 是本地路径,无法直接下载或访问。如果需要下载、查看、使用或展示照片,请使用 upload_photo 工具将 mediaUri或者thumbnailUri 转换为可访问的公网 URL。
  c. mediaUri代表手机相册中的图片原图路径，图片大小比较大，清晰度比较高
  d. thumbnailUri代表手机相册中的图片缩略图路径，图片大小比较小，清晰度适中，建议在upload_photo 工具的入参中优先使用此路径，不容易引起上传超时等问题
  
  注意事项：
  a. 只有当用户明确表达从手机相册搜索或者从图库搜索时才执行此工具，如果用户仅表达要搜索xxx图片，并没有说明搜索数据源，则不要贸然调用此插件，可以优先尝试websearch或者询问用户是否要从手机图库中搜索。
  b. 操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。
  `,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "图像描述语料，用于检索匹配的照片（例如：'小狗的照片'、'带有键盘的图片'等）",
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 🚀 Starting execution`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.query) {
      logger.error(`[SEARCH_PHOTO_GALLERY_TOOL] ❌ Missing required parameter: query`);
      throw new Error("Missing required parameter: query is required");
    }

    // Get session context
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[SEARCH_PHOTO_GALLERY_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEARCH_PHOTO_GALLERY_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Search photo gallery tool can only be used during an active conversation.");
    }

    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] ✅ Session context found`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] ✅ WebSocket manager obtained`);

    // Search for photos
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📸 Searching for photos...`);
    const items = await searchPhotos(wsManager, config, sessionId, taskId, messageId, params.query);

    if (!items || items.length === 0) {
      logger.warn(`[SEARCH_PHOTO_GALLERY_TOOL] ⚠️ No photos found for query: ${params.query}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              items: [],
              count: 0,
              message: "未找到匹配的照片"
            }),
          },
        ],
      };
    }

    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] ✅ Found ${items.length} photos`);
    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - items:`, JSON.stringify(items));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items,
            count: items.length,
            message: `找到 ${items.length} 张照片。注意：mediaUri 和 thumbnailUri 是本地路径，无法直接访问。如需下载或查看，请使用 upload_photo 工具。`
          }),
        },
      ],
    };
  },
};

/**
 * Search for photos using query description
 * Returns array of photo items with complete information
 */
async function searchPhotos(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  query: string
): Promise<any[]> {
  logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📦 Building SearchPhotoVideo command...`);

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "SearchPhotoVideo",
        bundleName: "com.huawei.hmos.aidispatchservice",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          query: query,
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

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.error(`[SEARCH_PHOTO_GALLERY_TOOL] ⏰ Timeout: No response for SearchPhotoVideo within 60 seconds`);
      wsManager.off("data-event", handler);
      reject(new Error("搜索照片超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📨 Received data event:`, JSON.stringify(event));

      if (event.intentName === "SearchPhotoVideo") {
        logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 🎯 SearchPhotoVideo event received`);
        logger.log(`[SEARCH_PHOTO_GALLERY_TOOL]   - status: ${event.status}`);

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] ✅ Photo search completed successfully`);

          const result = event.outputs.result;
          const items = result?.items || [];

          logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📊 Found ${items.length} photo items`);
          resolve(items);
        } else {
          logger.error(`[SEARCH_PHOTO_GALLERY_TOOL] ❌ Photo search failed`);
          logger.error(`[SEARCH_PHOTO_GALLERY_TOOL]   - status: ${event.status}`);
          reject(new Error(`搜索照片失败: ${event.status}`));
        }
      }
    };

    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📡 Registering data-event handler for SearchPhotoVideo`);
    wsManager.on("data-event", handler);

    logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] 📤 Sending SearchPhotoVideo command...`);
    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
        logger.log(`[SEARCH_PHOTO_GALLERY_TOOL] ✅ SearchPhotoVideo command sent successfully`);
      })
      .catch((error) => {
        logger.error(`[SEARCH_PHOTO_GALLERY_TOOL] ❌ Failed to send SearchPhotoVideo command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}
