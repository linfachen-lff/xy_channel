// Upload File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload file tool - uploads local files to get publicly accessible URLs.
 * Requires file URIs from search_file tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_file tool first to get URIs of files
 * 2. Use the URIs to get public URLs
 *
 * Usage Note:
 * - After getting public URLs, if further processing is needed, download the file first
 * - URLs returned are publicly accessible
 */
export const uploadFileTool: any = {
  name: "upload_file",
  label: "Upload File",
  description: `工具能力描述：将手机本地文件上传并获取可公网访问的 URL。

  前置工具调用：此工具使用前必须先调用 search_file 工具获取文件的 uri

  工具参数说明：
  a. 入参中的fileInfos数组，每个元素必须包含mediaUri字段（对应于search_file工具返回结果中的uri），必须与search_file结果中对应的uri完全保持一致，不要自行修改。
  b. fileInfos中的timeout字段是可选的，表示上传文件超时时间，单位是毫秒，默认是20000（20秒）。
  c. fileInfos 是文件在手机本地的信息数组（从 search_file 工具响应中获取）。限制：每次最多支持传入 5 条文件信息。

  注意事项：
  a. 操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。
  b. 此工具返回的文件链接为用户公网可访问的链接，如果需要对文件进行额外的操作，需要先根据返回的url下载文件，然后进行下一步处理。`,
  parameters: {
    type: "object",
    properties: {
      fileInfos: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "文件信息数组，每个元素包含mediaUri（必需）和timeout（可选，默认20000）。必须先通过 search_file 工具获取。每次最多支持 5 条文件信息。",
      },
    },
    required: ["fileInfos"],
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[UPLOAD_FILE_TOOL] 🚀 Starting execution`);
    logger.log(`[UPLOAD_FILE_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[UPLOAD_FILE_TOOL]   - params (raw):`, JSON.stringify(params));
    logger.log(`[UPLOAD_FILE_TOOL]   - params.fileInfos type:`, typeof params.fileInfos);
    logger.log(`[UPLOAD_FILE_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let fileInfos: Array<{ mediaUri: string; timeout?: string }> | null = null;

    if (!params.fileInfos) {
      logger.error(`[UPLOAD_FILE_TOOL] ❌ Missing parameter: fileInfos`);
      throw new Error("Missing required parameter: fileInfos");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.fileInfos)) {
      logger.log(`[UPLOAD_FILE_TOOL] ✅ fileInfos is already an array`);
      fileInfos = params.fileInfos;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.fileInfos === 'string') {
      logger.log(`[UPLOAD_FILE_TOOL] 🔄 fileInfos is a string, attempting to parse as JSON...`);
      try {
        const parsed = JSON.parse(params.fileInfos);
        if (Array.isArray(parsed)) {
          logger.log(`[UPLOAD_FILE_TOOL] ✅ Successfully parsed JSON string to array`);
          fileInfos = parsed;
        } else {
          logger.error(`[UPLOAD_FILE_TOOL] ❌ Parsed JSON is not an array:`, typeof parsed);
          throw new Error("fileInfos must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        logger.error(`[UPLOAD_FILE_TOOL] ❌ Failed to parse fileInfos as JSON:`, parseError);
        throw new Error(`fileInfos must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      logger.error(`[UPLOAD_FILE_TOOL] ❌ Invalid fileInfos type:`, typeof params.fileInfos);
      throw new Error(`fileInfos must be an array or a JSON string, got ${typeof params.fileInfos}`);
    }

    // 验证数组非空
    if (!fileInfos || fileInfos.length === 0) {
      logger.error(`[UPLOAD_FILE_TOOL] ❌ fileInfos array is empty`);
      throw new Error("fileInfos array cannot be empty");
    }

    logger.log(`[UPLOAD_FILE_TOOL] ✅ Normalized fileInfos:`, JSON.stringify(fileInfos));

    // Validate maximum 5 file infos
    if (fileInfos.length > 5) {
      logger.error(`[UPLOAD_FILE_TOOL] ❌ Too many fileInfos: ${fileInfos.length}`);
      throw new Error(`最多支持 5 条文件信息，当前提供了 ${fileInfos.length} 条。请分批处理。`);
    }

    // Validate each fileInfo has required mediaUri field
    for (let i = 0; i < fileInfos.length; i++) {
      const fileInfo = fileInfos[i];
      if (!fileInfo || typeof fileInfo !== 'object') {
        logger.error(`[UPLOAD_FILE_TOOL] ❌ fileInfo at index ${i} is not an object`);
        throw new Error(`fileInfos[${i}] must be an object with mediaUri property`);
      }
      if (!fileInfo.mediaUri || typeof fileInfo.mediaUri !== 'string') {
        logger.error(`[UPLOAD_FILE_TOOL] ❌ fileInfo at index ${i} missing or invalid mediaUri`);
        throw new Error(`fileInfos[${i}] must have a valid mediaUri string property`);
      }
      // Set default timeout if not provided
      if (!fileInfo.timeout) {
        fileInfo.timeout = "20000";
      }
    }

    logger.log(`[UPLOAD_FILE_TOOL]   - fileInfos count: ${fileInfos.length}`);

    // Get session context
    logger.log(`[UPLOAD_FILE_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[UPLOAD_FILE_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[UPLOAD_FILE_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Upload file tool can only be used during an active conversation.");
    }

    logger.log(`[UPLOAD_FILE_TOOL] ✅ Session context found`);
    logger.log(`[UPLOAD_FILE_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[UPLOAD_FILE_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[UPLOAD_FILE_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[UPLOAD_FILE_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[UPLOAD_FILE_TOOL] ✅ WebSocket manager obtained`);

    // Get public URLs for the files
    logger.log(`[UPLOAD_FILE_TOOL] 🌐 Getting public URLs for files...`);
    const fileUrls = await getFileUrls(wsManager, config, sessionId, taskId, messageId, fileInfos);

    logger.log(`[UPLOAD_FILE_TOOL] 🎉 Successfully retrieved ${fileUrls.length} file URLs`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fileUrls,
            count: fileUrls.length,
            message: `成功获取 ${fileUrls.length} 个文件的公网访问 URL`
          }),
        },
      ],
    };
  },
};

/**
 * Get public URLs for files using fileInfos
 * Returns array of publicly accessible file URLs
 */
async function getFileUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  fileInfos: Array<{ mediaUri: string; timeout?: string }>
): Promise<string[]> {
  logger.log(`[UPLOAD_FILE_TOOL] 📦 Building FileUploadForClaw command...`);

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "FileUploadForClaw",
        bundleName: "com.huawei.hmos.vassistant",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          fileInfos: fileInfos,
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
      logger.error(`[UPLOAD_FILE_TOOL] ⏰ Timeout: No response for FileUploadForClaw within 60 seconds`);
      wsManager.off("data-event", handler);
      reject(new Error("获取文件URL超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      logger.log(`[UPLOAD_FILE_TOOL] 📨 Received data event:`, JSON.stringify(event));

      if (event.intentName === "FileUploadForClaw") {
        logger.log(`[UPLOAD_FILE_TOOL] 🎯 FileUploadForClaw event received`);
        logger.log(`[UPLOAD_FILE_TOOL]   - status: ${event.status}`);

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          logger.log(`[UPLOAD_FILE_TOOL] ✅ File URL retrieval completed successfully`);

          // Check for error code in outputs
          const code = event.outputs.code !== undefined ? event.outputs.code : null;

          if (code !== null && code !== 0) {
            logger.error(`[UPLOAD_FILE_TOOL] ❌ Device returned error`);
            logger.error(`[UPLOAD_FILE_TOOL]   - code: ${code}`);
            const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
            logger.error(`[UPLOAD_FILE_TOOL]   - errorMsg: ${errorMsg}`);
            reject(new Error(`获取文件URL失败: ${errorMsg} (错误代码: ${code})`));
            return;
          }

          // Safe navigation through outputs structure
          const outputs = event.outputs;
          const result = outputs?.result;
          let fileUrls: string[] = [];

          if (result && typeof result === 'object') {
            const urls = result.fileUrls;
            if (Array.isArray(urls)) {
              fileUrls = urls;
            }
          }

          // Decode Unicode escape sequences in URLs
          // Replace \u003d with = and \u0026 with &
          fileUrls = fileUrls.map((url: string) => {
            if (typeof url !== 'string') {
              logger.warn(`[UPLOAD_FILE_TOOL] ⚠️ URL is not a string:`, typeof url);
              return '';
            }
            const decodedUrl = url
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&');
            logger.log(`[UPLOAD_FILE_TOOL] 🔄 Decoded URL: ${url} -> ${decodedUrl}`);
            return decodedUrl;
          }).filter((url: string) => url.length > 0);

          logger.log(`[UPLOAD_FILE_TOOL] 📊 Retrieved and decoded ${fileUrls.length} file URLs`);
          resolve(fileUrls);
        } else {
          logger.error(`[UPLOAD_FILE_TOOL] ❌ File URL retrieval failed`);
          logger.error(`[UPLOAD_FILE_TOOL]   - status: ${event.status}`);
          logger.error(`[UPLOAD_FILE_TOOL]   - outputs:`, JSON.stringify(event.outputs || {}));
          reject(new Error(`获取文件URL失败: ${event.status}`));
        }
      }
    };

    logger.log(`[UPLOAD_FILE_TOOL] 📡 Registering data-event handler for FileUploadForClaw`);
    wsManager.on("data-event", handler);

    logger.log(`[UPLOAD_FILE_TOOL] 📤 Sending FileUploadForClaw command...`);
    sendCommand({
      config,
      sessionId,
      taskId,
      messageId,
      command,
    })
      .then(() => {
        logger.log(`[UPLOAD_FILE_TOOL] ✅ FileUploadForClaw command sent successfully`);
      })
      .catch((error) => {
        logger.error(`[UPLOAD_FILE_TOOL] ❌ Failed to send FileUploadForClaw command:`, error);
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}
