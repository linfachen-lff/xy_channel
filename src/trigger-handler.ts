// Trigger 事件处理器
import { randomUUID } from "crypto";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { A2AJsonRpcRequest, OutboundWebSocketMessage } from "./types.js";
import { getPushDataById } from "./utils/pushdata-manager.js";
import { handleXYMessage } from "./bot.js";
import { resolveXYConfig } from "./config.js";
import { getXYWebSocketManager } from "./client.js";

/**
 * Trigger 事件上下文
 */
export interface TriggerEventContext {
  event: any;           // Trigger 事件对象
  sessionId: string;    // 会话ID
  taskId: string;       // 任务ID（点击推送时生成的新ID）
}

/**
 * 处理 Trigger 事件
 * 当用户在手机侧点击推送消息时触发
 *
 * @param context - Trigger 事件上下文（包含 event, sessionId, taskId）
 * @param cfg - OpenClaw 配置
 * @param runtime - 运行时环境
 * @param accountId - 账号ID
 */
export async function handleTriggerEvent(
  context: TriggerEventContext,
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  accountId: string
): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  try {
    const { event, sessionId, taskId } = context;

    log(`[TRIGGER_HANDLER] 📌 Received Trigger event`);
    log(`[TRIGGER_HANDLER] Event:`, JSON.stringify(event, null, 2));
    log(`[TRIGGER_HANDLER] Context - sessionId: ${sessionId}, taskId: ${taskId}`);

    if (!sessionId) {
      error(`[TRIGGER_HANDLER] ❌ Missing sessionId in context`);
      return;
    }

    if (!taskId) {
      error(`[TRIGGER_HANDLER] ❌ Missing taskId in context`);
      return;
    }

    // 从 event.payload.dataMap 中提取 pushDataId
    const pushDataId = event.payload?.dataMap?.pushDataId;

    if (!pushDataId) {
      error(`[TRIGGER_HANDLER] ❌ Missing pushDataId in Trigger event payload`);
      return;
    }

    log(`[TRIGGER_HANDLER] 🔍 Looking up pushDataId: ${pushDataId}`);

    // 根据 pushDataId 查询原始数据
    const pushDataItem = await getPushDataById(pushDataId);

    if (!pushDataItem) {
      error(`[TRIGGER_HANDLER] ❌ pushData not found for ID: ${pushDataId}`);
      return;
    }

    log(`[TRIGGER_HANDLER] ✅ Found pushData`);
    log(`[TRIGGER_HANDLER]   - pushDataId: ${pushDataItem.pushDataId}`);
    log(`[TRIGGER_HANDLER]   - time: ${pushDataItem.time}`);
    log(`[TRIGGER_HANDLER]   - dataDetail length: ${pushDataItem.dataDetail.length} chars`);

    // ==================== 新逻辑：直接返回结果 ====================
    log(`[TRIGGER_HANDLER] 📤 Directly responding with pushData content`);

    // 获取配置
    const config = resolveXYConfig(cfg);

    // 构造 A2A Response（final=true，直接结束）
    const messageId = randomUUID();
    const response = {
      jsonrpc: "2.0",
      id: messageId,
      result: {
        taskId: taskId,
        kind: "artifact-update",
        append: false,
        lastChunk: true,
        final: true, // 直接结束
        artifact: {
          artifactId: randomUUID(),
          parts: [
            {
              kind: "text",
              text: pushDataItem.dataDetail, // 直接返回原始内容
            },
          ],
        },
      },
      error: { code: 0 },
    };

    // 构造 WebSocket 消息
    const outboundMessage: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: config.agentId,
      sessionId: sessionId,
      taskId: taskId,
      msgDetail: JSON.stringify(response),
    };

    log(`[TRIGGER_HANDLER] 📦 Sending direct response:`);
    log(`[TRIGGER_HANDLER]   - sessionId: ${sessionId}`);
    log(`[TRIGGER_HANDLER]   - taskId: ${taskId}`);
    log(`[TRIGGER_HANDLER]   - messageId: ${messageId}`);
    log(`[TRIGGER_HANDLER]   - content length: ${pushDataItem.dataDetail.length} chars`);

    // 发送消息
    const wsManager = getXYWebSocketManager(config);
    await wsManager.sendMessage(sessionId, outboundMessage);

    log(`[TRIGGER_HANDLER] ✅ Direct response sent successfully`);
  } catch (err) {
    error(`[TRIGGER_HANDLER] ❌ Failed to handle Trigger event:`, err);
  }
}
