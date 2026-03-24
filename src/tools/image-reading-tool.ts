// Image Reading tool implementation
import { XYFileUploadService } from "../file-upload.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

/**
 * Check if value is a remote URL
 */
function isRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Check if value is a local file path
 */
async function isLocalFile(value: string): Promise<boolean> {
  try {
    const stats = await fs.stat(value);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Download remote file to local temp directory
 */
async function downloadRemoteFile(url: string): Promise<string> {
  logger.log(`[IMAGE_READING_TOOL] 📥 Downloading remote file: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get filename from URL or use default
    let filename = url.split("/").pop() || "downloaded_image";
    filename = filename.split("?")[0];

    // Ensure temp directory exists
    const tempDir = "/tmp/xy_channel";
    await fs.mkdir(tempDir, { recursive: true });

    // Generate unique filename to avoid conflicts
    const timestamp = Date.now();
    const ext = path.extname(filename) || ".jpg";
    const baseName = path.basename(filename, ext);
    const uniqueFilename = `${baseName}_${timestamp}${ext}`;
    const localPath = path.join(tempDir, uniqueFilename);

    // Save file to local temp directory
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(localPath, buffer);

    logger.log(`[IMAGE_READING_TOOL] ✅ File downloaded to: ${localPath}`);
    return localPath;
  } catch (error) {
    logger.error(`[IMAGE_READING_TOOL] ❌ Failed to download file from ${url}:`, error);
    throw new Error(`Failed to download remote file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Process image input: validate and convert local file to OBS URL, keep remote URL unchanged
 */
async function processImageInput(
  imageInput: string,
  uploadService: XYFileUploadService
): Promise<{ imageUrl: string; localPath?: string }> {
  logger.log(`[IMAGE_READING_TOOL] 🔄 Processing image input: ${imageInput}`);

  // Check if it's a remote URL
  if (isRemoteUrl(imageInput)) {
    logger.log(`[IMAGE_READING_TOOL] 🌐 Input is remote URL, downloading...`);
    const localPath = await downloadRemoteFile(imageInput);

    logger.log(`[IMAGE_READING_TOOL] 📤 Uploading downloaded file to OBS...`);
    const imageUrl = await uploadService.uploadFileAndGetUrl(localPath, "TEMPORARY_MATERIAL_DOC");

    if (!imageUrl) {
      logger.error(`[IMAGE_READING_TOOL] ❌ Failed to get URL after upload`);
      throw new Error("图片上传失败：无法获取图片访问地址");
    }

    logger.log(`[IMAGE_READING_TOOL] ✅ Uploaded to OBS: ${imageUrl}`);

    return { imageUrl, localPath };
  }

  // Check if it's a local file
  const isLocal = await isLocalFile(imageInput);
  if (isLocal) {
    logger.log(`[IMAGE_READING_TOOL] 📁 Input is local file, uploading...`);
    const imageUrl = await uploadService.uploadFileAndGetUrl(imageInput, "TEMPORARY_MATERIAL_DOC");

    if (!imageUrl) {
      logger.error(`[IMAGE_READING_TOOL] ❌ Failed to get URL after upload`);
      throw new Error("图片上传失败：无法获取图片访问地址");
    }

    logger.log(`[IMAGE_READING_TOOL] ✅ Uploaded to OBS: ${imageUrl}`);

    return { imageUrl };
  }

  throw new Error(`Invalid image input: must be a remote URL or local file path, got: ${imageInput}`);
}

/**
 * Call image understanding API with streaming response
 */
async function callImageUnderstandingAPI(
  imageUrl: string,
  text: string,
  apiKey: string,
  uid: string
): Promise<string> {
  logger.log(`[IMAGE_READING_TOOL] 🧠 Calling image understanding API...`);
  logger.log(`[IMAGE_READING_TOOL]   - imageUrl: ${imageUrl}`);
  logger.log(`[IMAGE_READING_TOOL]   - prompt: ${text}`);

  const apiUrl = "https://hag-drcn.op.dbankcloud.com/celia-claw/v1/sse-api/skill/execute";
  const traceId = uuidv4();

  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "x-hag-trace-id": traceId,
    "x-api-key": apiKey,
    "x-request-from": "openclaw",
    "x-uid": uid,
    "x-skill-id": "image_comprehension",
    "x-prd-pkg-name": "com.huawei.hag",
  };

  const payload = {
    version: "1.0",
    session: {
      isNew: false,
      sessionId: "wangyu202410241921",
      interactionId: 0,
    },
    endpoint: {
      device: {
        sid: "3df83a4a8124d7600f66206f96ea1e7e4e21c593adc4246bd20d450d8404cbf3",
        deviceId: "3f35019f-ba4c-4ed5-80c0-6ddcef741200",
        prdVer: "99.0.64.303",
        phoneType: "WLZ-AL10",
        sysVer: "HarmonyOS_2.0.0",
        deviceType: 0,
        timezone: "GMT+08:00",
      },
      locale: "zh-CN",
      sysLocale: "zh",
      countryCode: "CN",
    },
    utterance: { type: "text", original: text },
    actions: [
      {
        actionSn: uuidv4(),
        actionExecutorTask: {
          pluginId: "aeac4e92c32949c1b7fc02de262615e6",
          agentState: "OnShelf",
          actionName: "imageUnderStandStream",
          content: { imageUrl, text },
        },
      },
    ],
  };

  logger.log(`[IMAGE_READING_TOOL] 📡 Sending request with trace ID: ${traceId}`);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // @ts-ignore - node-fetch supports this
      timeout: 120000, // 2 minutes timeout
    });

    logger.log(`[IMAGE_READING_TOOL] 📨 Response status: ${response.status}`);
    logger.log(`[IMAGE_READING_TOOL] 📨 Content-Type: ${response.headers.get("Content-Type")}`);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[IMAGE_READING_TOOL] ❌ API request failed: ${response.status}`);
      logger.error(`[IMAGE_READING_TOOL] ❌ Response: ${errorText}`);
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    // Process SSE stream
    let lastCaption = "";
    let lineCount = 0;
    let buffer = "";

    logger.log(`[IMAGE_READING_TOOL] 📖 Reading SSE stream...`);

    // Read the response body as a stream
    if (!response.body) {
      throw new Error("Response body is null");
    }

    for await (const chunk of response.body) {
      if (!chunk) continue;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        lineCount++;
        const trimmedLine = line.replace(/\r$/, "");

        if (!trimmedLine) continue;

        if (trimmedLine.startsWith("data:")) {
          const dataContent = trimmedLine.substring(5).trim();

          if (dataContent && dataContent !== "[DONE]") {
            try {
              const dataJson = JSON.parse(dataContent);

              // Extract streamContent from abilityInfos
              if (dataJson.abilityInfos && Array.isArray(dataJson.abilityInfos)) {
                for (const info of dataJson.abilityInfos) {
                  if (info.actionExecutorResult?.reply?.streamInfo) {
                    const streamContent = info.actionExecutorResult.reply.streamInfo.streamContent;
                    if (streamContent) {
                      lastCaption = streamContent;
                      logger.log(`[IMAGE_READING_TOOL] 📝 Updated caption (length: ${streamContent.length})`);
                    }
                  }
                }
              }
            } catch (parseError) {
              logger.warn(`[IMAGE_READING_TOOL] ⚠️ Failed to parse JSON data:`, parseError);
            }
          }
        }
      }
    }

    logger.log(`[IMAGE_READING_TOOL] ✅ Stream processing complete`);
    logger.log(`[IMAGE_READING_TOOL]   - Total lines processed: ${lineCount}`);
    logger.log(`[IMAGE_READING_TOOL]   - Final caption length: ${lastCaption.length}`);

    if (!lastCaption) {
      throw new Error("No caption received from image understanding API");
    }

    return lastCaption;
  } catch (error) {
    logger.error(`[IMAGE_READING_TOOL] ❌ API call failed:`, error);
    throw error;
  }
}

/**
 * XY Image Reading tool - performs image understanding using local or remote image URLs.
 * Supports both local file paths and remote URLs.
 */
export const imageReadingTool: any = {
  name: "image_reading",
  label: "Image Reading",
  description: `
工具使用场景：
【必须调用此工具的情况】
1. 用户消息中包含 mediaPath 字段且不为空（表示用户发送了图片）
2. 用户希望理解图片内容，询问图片是什么，例如：
   - "这是什么？"
   - "图片里有什么？"
   - "帮我看看这张图"
   - "描述一下这张图片"
   - "分析一下这张照片"
   - "这个图片是什么意思"
   - "识别一下图片内容"
   - 或任何关于图片内容的理解、识别、分析类询问

当同时满足以上两个条件时，必须优先调用此工具进行图像理解。

工具能力描述：对图片进行理解和分析，返回图片的描述内容。

工具参数说明：
a. localUrl：本地图片文件路径（可选，通常从用户消息的 mediaPath 字段获取）
b. remoteUrl：公网图片地址（可选）
c. prompt：对图片的提示问题，默认为"描述这张图片内容"，可根据用户的具体问题自定义
d. localUrl 与 remoteUrl 任意一个不为空即可，优先使用 localUrl

注意事项：
a. 支持常见图片格式（jpg, png, gif等）
b. 远程图片会先下载到本地再处理
c. 操作超时时间为2分钟（120秒）
d. 返回图像理解的文本描述内容`,
  parameters: {
    type: "object",
    properties: {
      localUrl: {
        type: "string",
        description: "本地图片文件路径",
      },
      remoteUrl: {
        type: "string",
        description: "公网图片地址（HTTP/HTTPS URL）",
      },
      prompt: {
        type: "string",
        description: "对图片的提示问题，默认为'描述这张图片内容'",
      },
    },
  },

  async execute(toolCallId: string, params: any) {
    logger.log(`[IMAGE_READING_TOOL] 🚀 Starting execution`);
    logger.log(`[IMAGE_READING_TOOL]   - toolCallId: ${toolCallId}`);
    logger.log(`[IMAGE_READING_TOOL]   - params:`, JSON.stringify(params));
    logger.log(`[IMAGE_READING_TOOL]   - timestamp: ${new Date().toISOString()}`);

    // Validate that at least one parameter is provided
    if (!params.localUrl && !params.remoteUrl) {
      logger.error(`[IMAGE_READING_TOOL] ❌ Missing both localUrl and remoteUrl parameters`);
      throw new Error("At least one of localUrl or remoteUrl must be provided");
    }

    // Get prompt (default to "描述这张图片内容")
    const prompt = params.prompt || "描述这张图片内容";
    logger.log(`[IMAGE_READING_TOOL] 📝 Using prompt: ${prompt}`);

    // Get session context
    logger.log(`[IMAGE_READING_TOOL] 🔍 Getting session context...`);
    const sessionContext = getCurrentSessionContext();

    if (!sessionContext) {
      logger.error(`[IMAGE_READING_TOOL] ❌ No active session found!`);
      throw new Error("No active XY session found. Image reading tool can only be used during an active conversation.");
    }

    logger.log(`[IMAGE_READING_TOOL] ✅ Session context found`);
    const { config } = sessionContext;

    // Create upload service
    const uploadService = new XYFileUploadService(
      config.fileUploadUrl,
      config.apiKey,
      config.uid
    );

    let processedImage: { imageUrl: string; localPath?: string } | null = null;
    let downloadedFile: string | null = null;

    try {
      // Process image input (prefer localUrl over remoteUrl)
      const imageInput = params.localUrl || params.remoteUrl;
      logger.log(`[IMAGE_READING_TOOL] 🖼️ Processing image: ${imageInput}`);

      processedImage = await processImageInput(imageInput, uploadService);

      // Track downloaded file for cleanup
      if (processedImage.localPath) {
        downloadedFile = processedImage.localPath;
      }

      logger.log(`[IMAGE_READING_TOOL] ✅ Image processed successfully`);
      logger.log(`[IMAGE_READING_TOOL]   - OBS URL: ${processedImage.imageUrl}`);

      // Call image understanding API
      const caption = await callImageUnderstandingAPI(
        processedImage.imageUrl,
        prompt,
        config.apiKey,
        config.uid
      );

      logger.log(`[IMAGE_READING_TOOL] 🎉 Image understanding completed successfully`);
      logger.log(`[IMAGE_READING_TOOL]   - Caption length: ${caption.length} characters`);

      // Clean up downloaded file if any
      if (downloadedFile) {
        logger.log(`[IMAGE_READING_TOOL] 🧹 Cleaning up downloaded file...`);
        try {
          await fs.unlink(downloadedFile);
          logger.log(`[IMAGE_READING_TOOL] ✅ Cleaned up: ${downloadedFile}`);
        } catch (error) {
          logger.warn(`[IMAGE_READING_TOOL] ⚠️ Failed to clean up file:`, error);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              caption,
              prompt,
              imageSource: params.localUrl ? "local" : "remote",
              success: true,
            }),
          },
        ],
      };
    } catch (error) {
      // Clean up downloaded file on error
      if (downloadedFile) {
        logger.log(`[IMAGE_READING_TOOL] 🧹 Cleaning up downloaded file after error...`);
        try {
          await fs.unlink(downloadedFile);
        } catch (cleanupError) {
          logger.warn(`[IMAGE_READING_TOOL] ⚠️ Failed to clean up file:`, cleanupError);
        }
      }

      logger.error(`[IMAGE_READING_TOOL] ❌ Execution failed:`, error);
      const errorMessage = error instanceof Error ? error.message : "图片分析失败";

      // Return error result instead of throwing
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: errorMessage,
              prompt,
              imageSource: params.localUrl ? "local" : "remote",
              success: false,
            }),
          },
        ],
      };
    }
  },
};
