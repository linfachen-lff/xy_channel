// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { createXYReplyDispatcher } from "./reply-dispatcher.js";
import { parseA2AMessage, extractTextFromParts, extractFileParts, extractPushId, extractTriggerData, isClearContextMessage, isTasksCancelMessage } from "./parser.js";
import { downloadFilesFromParts } from "./file-download.js";
import { resolveXYConfig } from "./config.js";
import { sendStatusUpdate, sendClearContextResponse, sendTasksCancelResponse, sendA2AResponse } from "./formatter.js";
import { registerSession, unregisterSession, runWithSessionContext } from "./tools/session-manager.js";
import { configManager } from "./utils/config-manager.js";
import { addPushId } from "./utils/pushid-manager.js";
import { getPushDataById } from "./utils/pushdata-manager.js";
import {
  registerTaskId,
  incrementTaskIdRef,
  decrementTaskIdRef,
  lockTaskId,
  unlockTaskId,
  hasActiveTask,
} from "./task-manager.js";
import type { A2AJsonRpcRequest } from "./types.js";

/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  message: A2AJsonRpcRequest;
  accountId: string;
}

/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export async function handleXYMessage(params: HandleXYMessageParams): Promise<void> {
  const { cfg, runtime, message, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Get runtime (already validated in monitor.ts, but get reference for use)
  const core = getXYRuntime() as any;

  try {
    // Check for special messages BEFORE parsing (these have different param structures)
    const messageMethod = message.method;
    log(`[BOT-ENTRY] <<<<<<< Received message with method: ${messageMethod}, id: ${message.id} >>>>>>>`);
    log(`[BOT-ENTRY] Stack trace for debugging:`, new Error().stack?.split('\n').slice(1, 4).join('\n'));


    // Handle clearContext messages (params only has sessionId)
    if (messageMethod === "clearContext" || messageMethod === "clear_context") {
      const sessionId = message.params?.sessionId;
      if (!sessionId) {
        throw new Error("clearContext request missing sessionId in params");
      }
      log(`Clear context request for session ${sessionId}`);
      const config = resolveXYConfig(cfg);
      await sendClearContextResponse({
        config,
        sessionId,
        messageId: message.id,
      });
      return;
    }

    // Handle tasks/cancel messages
    if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
      const sessionId = message.params?.sessionId;
      const taskId = message.params?.id || message.id;
      if (!sessionId) {
        throw new Error("tasks/cancel request missing sessionId in params");
      }
      log(`Tasks cancel request for session ${sessionId}, task ${taskId}`);
      const config = resolveXYConfig(cfg);
      await sendTasksCancelResponse({
        config,
        sessionId,
        taskId,
        messageId: message.id,
      });
      return;
    }

    // Parse the A2A message (for regular messages)
    const parsed = parseA2AMessage(message);

    // ========== 检测 Trigger 消息 ==========
    // 如果消息中包含 Trigger 事件数据，直接返回 pushData 内容，不走正常流程
    const triggerData = extractTriggerData(parsed.parts);
    if (triggerData) {
      log(`[BOT] 📌 Detected Trigger message with pushDataId: ${triggerData.pushDataId}`);
      log(`[BOT]   - Session ID: ${parsed.sessionId}`);
      log(`[BOT]   - Task ID: ${parsed.taskId}`);

      try {
        // 读取 pushData
        const pushDataItem = await getPushDataById(triggerData.pushDataId);

        if (!pushDataItem) {
          error(`[BOT] ❌ pushData not found for ID: ${triggerData.pushDataId}`);
          return;
        }

        log(`[BOT] ✅ Found pushData, sending direct response`);
        log(`[BOT]   - pushDataId: ${pushDataItem.pushDataId}`);
        log(`[BOT]   - time: ${pushDataItem.time}`);
        log(`[BOT]   - content length: ${pushDataItem.dataDetail.length} chars`);

        const config = resolveXYConfig(cfg);

        // 直接发送响应（final=true，不走 openclaw 流程）
        await sendA2AResponse({
          config,
          sessionId: parsed.sessionId,
          taskId: parsed.taskId,
          messageId: parsed.messageId,
          text: pushDataItem.dataDetail,
          append: false,
          final: true,
        });

        log(`[BOT] ✅ Trigger response sent successfully, exiting early`);
        return;  // 提前返回，不继续处理
      } catch (err) {
        error(`[BOT] ❌ Failed to handle Trigger message:`, err);
        return;
      }
    }
    // ========================================

    // 🔑 检测steer模式和是否是第二条消息
    const isSteerMode = cfg.messages?.queue?.mode === "steer";
    const isSecondMessage = isSteerMode && hasActiveTask(parsed.sessionId);

    if (isSecondMessage) {
      log(`[BOT] 🔄 STEER MODE - Second message detected (will be follower)`);
      log(`[BOT]   - Session: ${parsed.sessionId}`);
      log(`[BOT]   - New taskId: ${parsed.taskId} (will replace current)`);
    }

    // 🔑 注册taskId（第二条消息会覆盖第一条的taskId）
    const { isUpdate, refCount } = registerTaskId(
      parsed.sessionId,
      parsed.taskId,
      parsed.messageId,
      { incrementRef: true }  // 增加引用计数
    );

    // 🔑 如果是第一条消息，锁定taskId防止被过早清理
    if (!isUpdate) {
      lockTaskId(parsed.sessionId);
      log(`[BOT] 🔒 Locked taskId for first message`);
    }

    // Extract and update push_id if present
    const pushId = extractPushId(parsed.parts);
    if (pushId) {
      log(`[BOT] 📌 Extracted push_id from user message`);
      log(`[BOT]   - Session ID: ${parsed.sessionId}`);
      log(`[BOT]   - Push ID preview: ${pushId.substring(0, 20)}...`);
      log(`[BOT]   - Full push_id: ${pushId}`);
      configManager.updatePushId(parsed.sessionId, pushId);

      // 持久化 pushId 到本地文件（异步，不阻塞主流程）
      addPushId(pushId).catch((err) => {
        error(`[BOT] Failed to persist pushId:`, err);
      });
    } else {
      log(`[BOT] ℹ️  No push_id found in message, will use config default`);
    }

    // Resolve configuration (needed for status updates)
    const config = resolveXYConfig(cfg);

    // ✅ Resolve agent route (following feishu pattern)
    // accountId is "default" for XY (single account mode)
    // Use sessionId as peer.id to ensure all messages in the same session share context
    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xiaoyi-channel",
      accountId,  // "default"
      peer: {
        kind: "direct" as const,
        id: parsed.sessionId,  // ✅ Use sessionId to share context within the same conversation session
      },
    });

    log(`xy: resolved route accountId=${route.accountId}, sessionKey=${route.sessionKey}`);

    // 🔑 注册session（带引用计数）
    log(`[BOT] 📝 About to register session for tools...`);
    log(`[BOT]   - sessionKey: ${route.sessionKey}`);
    log(`[BOT]   - sessionId: ${parsed.sessionId}`);
    log(`[BOT]   - taskId: ${parsed.taskId}`);
    log(`[BOT]   - isSecondMessage: ${isSecondMessage}`);

    registerSession(route.sessionKey, {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
    });

    log(`[BOT] ✅ Session registered for tools`);

    // 🔑 发送初始状态更新（第二条消息也要发，用新taskId）
    log(`[STATUS] Sending initial status update for session ${parsed.sessionId}`);
    void sendStatusUpdate({
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      text: isSecondMessage ? "新消息已接收，正在处理..." : "任务正在处理中，请稍后~",
      state: "working",
    }).catch((err) => {
      error(`Failed to send initial status update:`, err);
    });

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    const fileParts = extractFileParts(parsed.parts);

    // Download files to local disk
    const downloadedFiles = await downloadFilesFromParts(fileParts);
    const mediaPayload = buildXYMediaPayload(downloadedFiles);

    // Resolve envelope format options (following feishu pattern)
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with speaker prefix (following feishu pattern)
    let messageBody = text || "";

    // Add speaker prefix for clarity
    const speaker = parsed.sessionId;
    messageBody = `${speaker}: ${messageBody}`;

    // Format agent envelope (following feishu pattern)
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "xiaoyi-channel",
      from: speaker,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    // ✅ Finalize inbound context (following feishu pattern)
    // Use route.accountId and route.sessionKey instead of parsed fields
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: text || "",
      CommandBody: text || "",
      From: parsed.sessionId,
      To: parsed.sessionId,  // ✅ Simplified: use sessionId as target (context is managed by SessionKey)
      SessionKey: route.sessionKey,  // ✅ Use route.sessionKey
      AccountId: route.accountId,  // ✅ Use route.accountId ("default")
      ChatType: "direct" as const,
      GroupSubject: undefined,
      SenderName: parsed.sessionId,
      SenderId: parsed.sessionId,
      Provider: "xiaoyi-channel" as const,
      Surface: "xiaoyi-channel" as const,
      MessageSid: parsed.messageId,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "xiaoyi-channel" as const,
      OriginatingTo: parsed.sessionId,  // Original message target
      ReplyToBody: undefined, // A2A protocol doesn't support reply/quote
      ...mediaPayload,
    });

    // 🔑 创建dispatcher（dispatcher会自动使用动态taskId）
    log(`[BOT-DISPATCHER] 🎯 Creating reply dispatcher`);
    log(`[BOT-DISPATCHER]   - session: ${parsed.sessionId}`);
    log(`[BOT-DISPATCHER]   - taskId: ${parsed.taskId}`);
    log(`[BOT-DISPATCHER]   - isSecondMessage: ${isSecondMessage}`);

    const { dispatcher, replyOptions, markDispatchIdle, startStatusInterval } = createXYReplyDispatcher({
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,
      isSteerFollower: isSecondMessage,  // 🔑 标记第二条消息
    });
    log(`[BOT-DISPATCHER] ✅ Reply dispatcher created successfully`);

    // 🔑 只有第一条消息启动状态定时器
    // 第二条消息会很快返回，不需要定时器
    if (!isSecondMessage) {
      startStatusInterval();
      log(`[BOT-DISPATCHER] ✅ Status interval started for first message`);
    } else {
      log(`[BOT-DISPATCHER] ⏭️  Skipped status interval for steer follower`);
    }

    log(`xy: dispatching to agent (session=${parsed.sessionId})`);

    // Dispatch to OpenClaw core using correct API (following feishu pattern)
    log(`[BOT] 🚀 Starting dispatcher with session: ${route.sessionKey}`);

    // Build session context for AsyncLocalStorage
    const sessionContext = {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
    };

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        log(`[BOT] 🏁 onSettled called for session: ${route.sessionKey}`);
        log(`[BOT]   - isSecondMessage: ${isSecondMessage}`);

        markDispatchIdle();

        // 🔑 减少引用计数
        decrementTaskIdRef(parsed.sessionId);

        // 🔑 如果是第一条消息完成，解锁
        if (!isSecondMessage) {
          unlockTaskId(parsed.sessionId);
          log(`[BOT] 🔓 Unlocked taskId (first message completed)`);
        }

        // 减少session引用计数
        unregisterSession(route.sessionKey);

        log(`[BOT] ✅ Cleanup completed`);
      },
      run: () =>
        // 🔐 Use AsyncLocalStorage to provide session context to tools
        runWithSessionContext(sessionContext, () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions,
          })
        ),
    });

    log(`[BOT] ✅ Dispatcher completed for session: ${parsed.sessionId}`);
    log(`xy: dispatch complete (session=${parsed.sessionId})`);
  } catch (err) {
    // ✅ Only log error, don't re-throw to prevent gateway restart
    error("Failed to handle XY message:", err);
    runtime.error?.(`xy: Failed to handle message: ${String(err)}`);

    log(`[BOT] ❌ Error occurred, attempting cleanup...`);

    // 🔑 错误时也要清理taskId和session
    try {
      const params = message.params as any;
      const sessionId = params?.sessionId;
      if (sessionId) {
        log(`[BOT] 🧹 Cleaning up after error: ${sessionId}`);

        // 清理 taskId
        decrementTaskIdRef(sessionId);
        unlockTaskId(sessionId);

        // 清理 session
        const core = getXYRuntime() as any;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "xiaoyi-channel",
          accountId,
          peer: {
            kind: "direct" as const,
            id: sessionId,
          },
        });

        unregisterSession(route.sessionKey);
        log(`[BOT] ✅ Cleanup completed after error`);
      }
    } catch (cleanupErr) {
      log(`[BOT] ⚠️  Cleanup failed:`, cleanupErr);
      // Ignore cleanup errors
    }

    // ❌ Don't re-throw: message processing error should not affect gateway stability
  }
}

/**
 * Build media payload for inbound context.
 * Following feishu pattern: buildFeishuMediaPayload().
 *
 * @param mediaList - Downloaded files with local paths
 */
function buildXYMediaPayload(
  mediaList: Array<{ path: string; name: string; mimeType: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.mimeType).filter(Boolean);
  return {
    MediaPath: first?.path,
    MediaType: first?.mimeType,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

/**
 * Infer OpenClaw media type from file type string.
 */
function inferMediaType(fileType: string): "image" | "video" | "audio" | "file" {
  const lower = fileType.toLowerCase();
  if (lower.includes("image") || /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(lower)) {
    return "image";
  }
  if (lower.includes("video") || /\.(mp4|avi|mov|mkv|webm)$/i.test(lower)) {
    return "video";
  }
  if (lower.includes("audio") || /\.(mp3|wav|ogg|m4a)$/i.test(lower)) {
    return "audio";
  }
  return "file";
}
