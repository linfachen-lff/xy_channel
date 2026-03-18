// Send File to User tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { XYFileUploadService } from "../file-upload.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { OutboundWebSocketMessage } from "../types.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

/**
 * File extension to MIME type mapping
 */
const FILE_TYPE_TO_MIME_TYPE: Record<string, string> = {
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && FILE_TYPE_TO_MIME_TYPE[extension]) {
    return FILE_TYPE_TO_MIME_TYPE[extension];
  }
  return "text/plain";
}

/**
 * Normalize parameter to array (supports both array and JSON string)
 */
function normalizeToArray(param: any): string[] {
  if (Array.isArray(param)) {
    return param;
  }

  if (typeof param === 'string') {
    try {
      const parsed = JSON.parse(param);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      throw new Error("Parameter must be an array or a JSON string representing an array");
    } catch (parseError) {
      throw new Error(`Parameter must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
  }

  throw new Error(`Parameter must be an array or a JSON string, got ${typeof param}`);
}

/**
 * Download remote file to local temp directory
 */
async function downloadRemoteFile(url: string): Promise<string> {
  logger.log(`[SEND_FILE_TO_USER_TOOL] 📥 Downloading remote file: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get filename from URL or use default
    let filename = url.split("/").pop() || "downloaded_file";
    // Remove query parameters if present
    filename = filename.split("?")[0];

    // Ensure temp directory exists
    const tempDir = "/tmp/xy_channel";
    await fs.mkdir(tempDir, { recursive: true });

    // Generate unique filename to avoid conflicts
    const timestamp = Date.now();
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const uniqueFilename = `${baseName}_${timestamp}${ext}`;
    const localPath = path.join(tempDir, uniqueFilename);

    // Save file to local temp directory
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(localPath, buffer);

    logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ File downloaded to: ${localPath}`);
    return localPath;
  } catch (error) {
    logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ Failed to download file from ${url}:`, error);
    throw new Error(`Failed to download remote file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * XY send file to user tool - sends local files or remote files to user's device.
 * Supports both local file paths and remote URLs.
 */
export const sendFileToUserTool: any = {
  name: "send_file_to_user",
  label: "Send File to User",
  description: `工具能力描述：帮助用户把本地的文件或者公网地址的文件传到手机。

工具参数说明：
a. fileLocalUrls：本地文件路径数组，包含用户需要回传的文件在本地的地址
b. fileRemoteUrls：公网地址数组，包含用户需要回传的文件的公网地址（会先下载到本地再发送）
c. fileLocalUrls 与 fileRemoteUrls 任意一个不为空即可，两者都提供时都会处理

注意事项：
a. 支持传入数组或 JSON 字符串格式
b. 操作超时时间为2分钟（120秒），请勿重复调用此工具，如果超时或失败，最多重试一次`,
  parameters: {
    type: "object",
    properties: {
      fileLocalUrls: {
        description: "本地文件路径数组，包含用户需要回传的文件在本地的地址",
      },
      fileRemoteUrls: {
        description: "公网地址数组，包含用户需要回传的文件的公网地址（会先下载到本地再发送）",
      },
    },
  },

  async execute(toolCallId: string, params: any) {
    // Set timeout for the entire operation (2 minutes)
    const TOOL_TIMEOUT = 120000; // 2 minutes in milliseconds
    let timeoutHandle: NodeJS.Timeout | null = null;

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("操作超时（2分钟）"));
      }, TOOL_TIMEOUT);
    });

    // Create the main execution promise
    const executionPromise = (async () => {
    logger.log(`[SEND_FILE_TO_USER_TOOL] 🚀 Starting execution`);
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - params (raw):`, JSON.stringify(params));
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate that at least one parameter is provided
    if (!params.fileLocalUrls && !params.fileRemoteUrls) {
      logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ Missing both fileLocalUrls and fileRemoteUrls parameters`);
      throw new Error("At least one of fileLocalUrls or fileRemoteUrls must be provided");
    }

    // Normalize fileLocalUrls parameter
    let fileLocalUrls: string[] = [];
    if (params.fileLocalUrls) {
      logger.log(`[SEND_FILE_TO_USER_TOOL] 🔄 Normalizing fileLocalUrls parameter...`);
      fileLocalUrls = normalizeToArray(params.fileLocalUrls);

      if (fileLocalUrls.length === 0) {
        logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ fileLocalUrls array is empty`);
        throw new Error("fileLocalUrls array cannot be empty");
      }

      logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Normalized fileLocalUrls:`, JSON.stringify(fileLocalUrls));
    }

    // Normalize fileRemoteUrls parameter
    let fileRemoteUrls: string[] = [];
    if (params.fileRemoteUrls) {
      logger.log(`[SEND_FILE_TO_USER_TOOL] 🔄 Normalizing fileRemoteUrls parameter...`);
      fileRemoteUrls = normalizeToArray(params.fileRemoteUrls);

      if (fileRemoteUrls.length === 0) {
        logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ fileRemoteUrls array is empty`);
        throw new Error("fileRemoteUrls array cannot be empty");
      }

      logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Normalized fileRemoteUrls:`, JSON.stringify(fileRemoteUrls));
    }

    // Get session context
    logger.log(`[SEND_FILE_TO_USER_TOOL] 🔍 Attempting to get session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ FAILED: No active session found!`);
      logger.error(`[SEND_FILE_TO_USER_TOOL]   - toolCallId: ${toolCallId}`);
      throw new Error("No active XY session found. Send file to user tool can only be used during an active conversation.");
    }

    logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Session context found`);
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - sessionId: ${sessionContext.sessionId}`);
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - taskId: ${sessionContext.taskId}`);
    logger.log(`[SEND_FILE_TO_USER_TOOL]   - messageId: ${sessionContext.messageId}`);

    const { config, sessionId, taskId, messageId } = sessionContext;

    // Get WebSocket manager
    logger.log(`[SEND_FILE_TO_USER_TOOL] 🔌 Getting WebSocket manager...`);
    const wsManager = getXYWebSocketManager(config);
    logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ WebSocket manager obtained`);

    // Create upload service
    const uploadService = new XYFileUploadService(
      config.fileUploadUrl,
      config.apiKey,
      config.uid
    );

    // Collect all local file paths to upload
    const allLocalPaths: string[] = [...fileLocalUrls];
    const downloadedFiles: string[] = [];

    // Download remote files to local temp directory
    if (fileRemoteUrls.length > 0) {
      logger.log(`[SEND_FILE_TO_USER_TOOL] 📥 Downloading ${fileRemoteUrls.length} remote files...`);

      for (let i = 0; i < fileRemoteUrls.length; i++) {
        const remoteUrl = fileRemoteUrls[i];
        logger.log(`[SEND_FILE_TO_USER_TOOL] 📥 Downloading remote file ${i + 1}/${fileRemoteUrls.length}: ${remoteUrl}`);

        try {
          const localPath = await downloadRemoteFile(remoteUrl);
          allLocalPaths.push(localPath);
          downloadedFiles.push(localPath);
        } catch (error) {
          logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ Failed to download file ${i + 1}:`, error);
          throw new Error(`Failed to download remote file ${remoteUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Downloaded ${downloadedFiles.length} remote files`);
    }

    // Upload all local files and get fileIds
    logger.log(`[SEND_FILE_TO_USER_TOOL] 📤 Uploading ${allLocalPaths.length} files...`);
    const uploadedFiles: Array<{ fileName: string; fileId: string; mimeType: string }> = [];

    for (let i = 0; i < allLocalPaths.length; i++) {
      const localPath = allLocalPaths[i];
      logger.log(`[SEND_FILE_TO_USER_TOOL] 📤 Uploading file ${i + 1}/${allLocalPaths.length}: ${localPath}`);

      try {
        // Upload file using three-phase upload
        const fileId = await uploadService.uploadFile(localPath);

        if (!fileId) {
          logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ Failed to upload file: ${localPath} (fileId is empty)`);
          throw new Error(`Failed to upload file: ${localPath}`);
        }

        // Get filename and mime type
        const fileName = localPath.split("/").pop() || "unknown";
        const mimeType = getMimeTypeFromFilename(fileName);

        uploadedFiles.push({ fileName, fileId, mimeType });
        logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ File uploaded successfully: ${fileName} -> ${fileId}`);
      } catch (error) {
        logger.error(`[SEND_FILE_TO_USER_TOOL] ❌ Failed to upload file ${i + 1}:`, error);
        throw new Error(`Failed to upload file ${localPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Clean up downloaded files
    if (downloadedFiles.length > 0) {
      logger.log(`[SEND_FILE_TO_USER_TOOL] 🧹 Cleaning up ${downloadedFiles.length} downloaded files...`);
      for (const downloadedFile of downloadedFiles) {
        try {
          await fs.unlink(downloadedFile);
          logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Cleaned up: ${downloadedFile}`);
        } catch (error) {
          logger.warn(`[SEND_FILE_TO_USER_TOOL] ⚠️ Failed to clean up file ${downloadedFile}:`, error);
        }
      }
    }

    // Build and send agent_response messages for each file
    logger.log(`[SEND_FILE_TO_USER_TOOL] 📦 Building and sending agent_response messages...`);
    const sentFiles: Array<{ fileName: string; fileId: string }> = [];

    for (const uploadedFile of uploadedFiles) {
      const { fileName, fileId, mimeType } = uploadedFile;

      const agentResponse: OutboundWebSocketMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId: sessionId,
        taskId: taskId,
        msgDetail: JSON.stringify({
          jsonrpc: "2.0",
          id: taskId,
          result: {
            kind: "artifact-update",
            append: true,
            lastChunk: false,
            final: false,
            artifact: {
              artifactId: taskId,
              parts: [
                {
                  kind: "file",
                  file: {
                    name: fileName,
                    mimeType: mimeType,
                    fileId: fileId,
                  },
                },
              ],
            },
          },
          error: { code: 0 },
        }),
      };

      // Send WebSocket message
      await wsManager.sendMessage(sessionId, agentResponse);
      sentFiles.push({ fileName, fileId });
      logger.log(`[SEND_FILE_TO_USER_TOOL] ✅ Sent file to user: ${fileName} (fileId: ${fileId})`);
    }

    logger.log(`[SEND_FILE_TO_USER_TOOL] 🎉 Successfully sent ${sentFiles.length} files to user`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sentFiles,
            count: sentFiles.length,
            message: `成功发送 ${sentFiles.length} 个文件到用户设备`
          }),
        },
      ],
    };
    })();

    // Race between execution and timeout
    try {
      const result = await Promise.race([executionPromise, timeoutPromise]) as any;
      // Clear timeout if execution completed
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return result;
    } catch (error) {
      // Clear timeout on error
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      throw error;
    }
  },
};
