// Trigger 事件处理器
import { randomUUID } from "crypto";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getPushDataById } from "./utils/pushdata-manager.js";
import { resolveXYConfig } from "./config.js";
import { sendTriggerResponse } from "./formatter.js";

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

    // 获取配置
    const config = resolveXYConfig(cfg);

    // 生成消息ID
    const messageId = randomUUID();

    log(`[TRIGGER_HANDLER] 📤 Sending Trigger response via formatter...`);
    log(`[TRIGGER_HANDLER]   - sessionId: ${sessionId}`);
    log(`[TRIGGER_HANDLER]   - taskId: ${taskId}`);
    log(`[TRIGGER_HANDLER]   - messageId: ${messageId}`);
    log(`[TRIGGER_HANDLER]   - content length: ${pushDataItem.dataDetail.length} chars`);

    // 使用 formatter 中的方法发送响应（复用已有消息链路）
    await sendTriggerResponse({
      config,
      sessionId,
      taskId,
      messageId,
      content: pushDataItem.dataDetail,
    });

    log(`[TRIGGER_HANDLER] ✅ Trigger response sent successfully`);
  } catch (err) {
    error(`[TRIGGER_HANDLER] ❌ Failed to handle Trigger event:`, err);
  }
}
