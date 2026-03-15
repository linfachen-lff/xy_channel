// Upload Photo tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getLatestSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload photo tool - uploads local photos to get publicly accessible URLs.
 * Requires mediaUris from search_photo_gallery tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_photo_gallery tool first to get mediaUris of photos
 * 2. Use the mediaUris (maximum 5 at a time) to get public URLs
 */
export const uploadPhotoTool: any = {
  name: "upload_photo",
  label: "Upload Photo",
  description: "将手机本地照片回传并获取可公网访问的 URL。使用前必须先调用 search_photo_gallery 工具获取照片的 mediaUri。参数说明：mediaUris 是照片在手机本地的 URI 数组（从 search_photo_gallery 工具获取）。限制：每次最多支持传入 5 条 mediaUri。操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。",
  parameters: {
    type: "object",
    properties: {
      mediaUris: {
        type: "array",
        items: {
          type: "string",
        },
        description: "照片在手机本地的 URI 数组，必须先通过 search_photo_gallery 工具获取。每次最多支持 5 条 URI。",
        maxItems: 5,
        minItems: 1,
      },
    },
    required: ["mediaUris"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[UPLOAD_PHOTO_TOOL] 🚀 Starting execution`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[UPLOAD_PHOTO_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate parameters
    if (!params.mediaUris || !Array.isArray(params.mediaUris) || params.mediaUris.length === 0) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Missing or invalid parameter: mediaUris`);
      throw new Error("Missing or invalid parameter: mediaUris must be a non-empty array");
    }

    // Validate maximum 5 URIs
    if (params.mediaUris.length > 5) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Too many mediaUris: ${params.mediaUris.length}`);
      throw new Error(`最多支持 5 条 mediaUri，当前提供了 ${params.mediaUris.length} 条。请分批处理。`);
    }

    logger.log(`[UPLOAD_PHOTO_TOOL]   - mediaUris count: ${params.mediaUris.length}`);

    // Get session context
    logger.log(`[UPLOAD_PHOTO_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getLatestSessionContext();

    if (!sessionContext) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[UPLOAD_PHOTO_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Upload photo tool can only be used during an active conversation.");
    }

    logger.log(`[UPLOAD_PHOTO_TOOL] ✅ Session context found`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[UPLOAD_PHOTO_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[UPLOAD_PHOTO_TOOL] ✅ WebSocket manager obtained`);

    // Get public URLs for the photos
    logger.log(`[UPLOAD_PHOTO_TOOL] 🌐 Getting public URLs for photos...`);
    const imageUrls = await getPhotoUrls(wsManager, config, sessionId, taskId, messageId, params.mediaUris);

    logger.log(`[UPLOAD_PHOTO_TOOL] 🎉 Successfully retrieved ${imageUrls.length} photo URLs`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            imageUrls,
            count: imageUrls.length,
            message: `成功获取 ${imageUrls.length} 张照片的公网访问 URL`
          }),
        },
      ],
    };
  },
};

/**
 * Get public URLs for photos using mediaUris
 * Returns array of publicly accessible image URLs
 */
async function getPhotoUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  mediaUris: string[]
): Promise<string[]> {
  logger.log(`[UPLOAD_PHOTO_TOOL] 📦 Building ImageUploadForClaw command...`);

  // Build imageInfos array from mediaUris
  const imageInfos = mediaUris.map(mediaUri => ({ mediaUri }));

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "ImageUploadForClaw",
        bundleName: "com.huawei.hmos.vassistant",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          imageInfos: imageInfos,
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
      logger.error(`[UPLOAD_PHOTO_TOOL] ⏰ Timeout: No response for ImageUploadForClaw within 60 seconds`);
      wsManager.off("data-event", handler);
      reject(new Error("获取照片URL超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      logger.log(`[UPLOAD_PHOTO_TOOL] 📨 Received data event:`, JSON.stringify(event));

      if (event.intentName === "ImageUploadForClaw") {
        logger.log(`[UPLOAD_PHOTO_TOOL] 🎯 ImageUploadForClaw event received`);
        logger.log(`[UPLOAD_PHOTO_TOOL]   - status: ${event.status}`);

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          logger.log(`[UPLOAD_PHOTO_TOOL] ✅ Image URL retrieval completed successfully`);

          const result = event.outputs.result;
          let imageUrls = result?.imageUrls || [];

          // Decode Unicode escape sequences in URLs
          // Replace \u003d with = and \u0026 with &
          imageUrls = imageUrls.map((url: string) => {
            const decodedUrl = url
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&');
            logger.log(`[UPLOAD_PHOTO_TOOL] 🔄 Decoded URL: ${url} -> ${decodedUrl}`);
            return decodedUrl;
          });

          logger.log(`[UPLOAD_PHOTO_TOOL] 📊 Retrieved and decoded ${imageUrls.length} image URLs`);
          resolve(imageUrls);
        } else {
          logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Image URL retrieval failed`);
          logger.error(`[UPLOAD_PHOTO_TOOL]   - status: ${event.status}`);
          reject(new Error(`获取照片URL失败: ${event.status}`));
        }
      }
    };

    logger.log(`[UPLOAD_PHOTO_TOOL] 📡 Registering data-event handler for ImageUploadForClaw`);
    wsManager.on("data-event", handler);

    logger.log(`[UPLOAD_PHOTO_TOOL] 📤 Sending ImageUploadForClaw command...`);
    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
        logger.log(`[UPLOAD_PHOTO_TOOL] ✅ ImageUploadForClaw command sent successfully`);
      })
      .catch((error) => {
        logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Failed to send ImageUploadForClaw command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}
