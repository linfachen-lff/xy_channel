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
  description: "将手机本地照片回传并获取可公网访问的 URL。使用前必须先调用 search_photo_gallery 工具获取照片的 mediaUri，mediaUris中的mediaUri必须与search_photo_gallery结果中对应的mediaUri完全保持一致，不要自行修改，必须是file:://开头的路径。参数说明：mediaUris 是照片在手机本地的 URI 数组或 JSON 字符串数组（从 search_photo_gallery 工具响应中获取）。限制：每次最多支持传入 5 条 mediaUri。操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。注意事项：此工具返回的图片链接为用户公网可访问的链接，如果需要后续操作需要下载到本地，如果需要返回给用户查看则直接以图片markdown的形式返回给用户",
  parameters: {
    type: "object",
    properties: {
      mediaUris: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "照片在手机本地的 URI 数组（或 JSON 字符串形式的数组），必须先通过 search_photo_gallery 工具获取。每次最多支持 5 条 URI。支持传入数组 [\"uri1\", \"uri2\"] 或 JSON 字符串 '[\"uri1\", \"uri2\"]'。",
      },
    },
    required: ["mediaUris"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[UPLOAD_PHOTO_TOOL] 🚀 Starting execution`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - params (raw):`, JSON.stringify(params));
    logger.log(`[UPLOAD_PHOTO_TOOL]   - params.mediaUris type:`, typeof params.mediaUris);
    logger.log(`[UPLOAD_PHOTO_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let mediaUris: string[] | null = null;

    if (!params.mediaUris) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Missing parameter: mediaUris`);
      throw new Error("Missing required parameter: mediaUris");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.mediaUris)) {
      logger.log(`[UPLOAD_PHOTO_TOOL] ✅ mediaUris is already an array`);
      mediaUris = params.mediaUris;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.mediaUris === 'string') {
      logger.log(`[UPLOAD_PHOTO_TOOL] 🔄 mediaUris is a string, attempting to parse as JSON...`);
      try {
        const parsed = JSON.parse(params.mediaUris);
        if (Array.isArray(parsed)) {
          logger.log(`[UPLOAD_PHOTO_TOOL] ✅ Successfully parsed JSON string to array`);
          mediaUris = parsed;
        } else {
          logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Parsed JSON is not an array:`, typeof parsed);
          throw new Error("mediaUris must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Failed to parse mediaUris as JSON:`, parseError);
        throw new Error(`mediaUris must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Invalid mediaUris type:`, typeof params.mediaUris);
      throw new Error(`mediaUris must be an array or a JSON string, got ${typeof params.mediaUris}`);
    }

    // 验证数组非空
    if (!mediaUris || mediaUris.length === 0) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ mediaUris array is empty`);
      throw new Error("mediaUris array cannot be empty");
    }

    logger.log(`[UPLOAD_PHOTO_TOOL] ✅ Normalized mediaUris:`, JSON.stringify(mediaUris));

    // Validate maximum 5 URIs
    if (mediaUris.length > 5) {
      logger.error(`[UPLOAD_PHOTO_TOOL] ❌ Too many mediaUris: ${mediaUris.length}`);
      throw new Error(`最多支持 5 条 mediaUri，当前提供了 ${mediaUris.length} 条。请分批处理。`);
    }

    logger.log(`[UPLOAD_PHOTO_TOOL]   - mediaUris count: ${mediaUris.length}`);

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
    const imageUrls = await getPhotoUrls(wsManager, config, sessionId, taskId, messageId, mediaUris);

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
