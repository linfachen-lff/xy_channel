// File download utilities
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { logger } from "./utils/logger.js";

/**
 * Download a file from URL to local path.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  logger.debug(`Downloading file from ${url} to ${destPath}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(destPath, buffer);

    logger.debug(`File downloaded successfully: ${destPath}`);
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`Download timeout (30s) for ${url}`);
      throw new Error(`Download timeout after 30 seconds`);
    }
    logger.error(`Failed to download file from ${url}:`, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Download files from A2A file parts.
 * Returns array of local file paths with metadata.
 *
 * @param fileParts - Array of file info from A2A message
 * @param tempDir - Temporary directory for downloaded files
 * @returns Array of downloaded file info (includes local path, name, mime type, and original URI)
 */
export async function downloadFilesFromParts(
  fileParts: Array<{ name: string; mimeType: string; uri: string }>,
  tempDir: string = "/tmp/xy_channel"
): Promise<Array<{ path: string; name: string; mimeType: string; uri: string }>> {
  // Create temp directory if it doesn't exist
  await fs.mkdir(tempDir, { recursive: true });

  const downloadedFiles: Array<{ path: string; name: string; mimeType: string; uri: string }> = [];

  for (const filePart of fileParts) {
    const { name, mimeType, uri } = filePart;

    // Generate safe file name
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = path.join(tempDir, `${Date.now()}_${safeName}`);

    try {
      await downloadFile(uri, destPath);
      downloadedFiles.push({
        path: destPath,    // ⭐ Local path
        name,
        mimeType,
        uri,              // ⭐ Original remote URL
      });
      logger.log(`✅ Downloaded: ${name} -> ${destPath}`);
    } catch (error) {
      logger.error(`❌ Failed to download file ${name}:`, error);
      // Continue with other files
    }
  }

  if (downloadedFiles.length > 0) {
    logger.log(`📦 Downloaded ${downloadedFiles.length}/${fileParts.length} files successfully`);
  }

  return downloadedFiles;
}
