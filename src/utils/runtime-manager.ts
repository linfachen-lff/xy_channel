// xiaoyi runtime 持久化管理器
import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const RUNTIME_FILE = "/home/sandbox/.openclaw/.xiaoyiruntime";

/**
 * 确保目录存在
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error(`[RuntimeManager] Failed to create directory ${dir}:`, error);
  }
}

/**
 * 保存 runtime 信息到 .xiaoyiruntime 文件
 * @param webSocketSessionId - WebSocket 层级的 sessionId (SESSION_ID)
 * @param conversationId - param 里的 sessionId (CONVERSATION_ID)
 * @param taskId - 任务 ID (param.id)
 */
export async function saveRuntimeInfo(
  webSocketSessionId: string,
  conversationId: string,
  taskId: string
): Promise<void> {
  if (!webSocketSessionId || !conversationId || !taskId) {
    logger.warn(`[RuntimeManager] Invalid params: SESSION_ID=${webSocketSessionId}, CONVERSATION_ID=${conversationId}, TASK_ID=${taskId}`);
    return;
  }

  try {
    await ensureDirectoryExists(RUNTIME_FILE);

    const content = `SESSION_ID=${webSocketSessionId}\nCONVERSATION_ID=${conversationId}\nTASK_ID=${taskId}\n`;
    await fs.writeFile(RUNTIME_FILE, content, "utf-8");

    logger.log(`[RuntimeManager] ✅ Saved runtime info to .xiaoyiruntime`);
    logger.log(`[RuntimeManager]   - SESSION_ID: ${webSocketSessionId}`);
    logger.log(`[RuntimeManager]   - CONVERSATION_ID: ${conversationId}`);
    logger.log(`[RuntimeManager]   - TASK_ID: ${taskId}`);
  } catch (error) {
    logger.error(`[RuntimeManager] Failed to save runtime info:`, error);
    // 不抛出异常，避免影响主流程
  }
}
