// Steer message injector for CSPL hook integration
import { getSessionContext } from "./tools/session-manager.js";
import { hasActiveTask, getCurrentTaskId } from "./task-manager.js";
import { handleXYMessage } from "./bot.js";
import { logger } from "./utils/logger.js";
import { randomUUID } from "node:crypto";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";

let cachedCfg: ClawdbotConfig | null = null;
let cachedRuntime: RuntimeEnv | null = null;
let cachedAccountId: string = "default";

/**
 * 在 handleXYMessage 入口处调用，缓存 cfg/runtime 供 steer 注入使用。
 */
export function setCachedContext(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  accountId: string,
): void {
  cachedCfg = cfg;
  cachedRuntime = runtime;
  cachedAccountId = accountId;
}

/**
 * 尝试向当前活跃会话注入 steer 消息。
 * 两层保险：
 *   1. getSessionContext(sessionKey) 确认是当前 XY 活跃 session
 *   2. hasActiveTask(sessionId) 确认任务仍在运行
 *
 * @param sessionKey  来自 after_tool_call ctx.sessionKey（per-peer 下精确对应一个 XY session）
 * @param message     要注入的用户消息文本
 * @returns           true=已注入，false=跳过
 */
export async function tryInjectSteer(
  sessionKey: string | undefined,
  message: string,
): Promise<boolean> {
  if (!sessionKey) {
    console.log("[STEER] No sessionKey provided, skipping");
    return false;
  }

  console.log(`[STEER] Looking up sessionKey=${sessionKey}`);

  // 1. 通过 sessionKey 查找活跃 session（per-peer 模式下 1:1 对应）
  const sessionCtx = getSessionContext(sessionKey);
  if (!sessionCtx) {
    console.log(`[STEER] sessionKey=${sessionKey} not in activeSessions, skipping`);
    return false;
  }

  const { sessionId } = sessionCtx;
  console.log(`[STEER] Found sessionId=${sessionId}`);

  // 2. 确认任务仍在运行
  const activeTaskId = getCurrentTaskId(sessionId);
  console.log(`[STEER] hasActiveTask=${hasActiveTask(sessionId)}, activeTaskId=${activeTaskId ?? "none"}`);

  if (!hasActiveTask(sessionId)) {
    console.log(`[STEER] Task already ended for sessionId=${sessionId}, skipping`);
    return false;
  }

  if (!cachedCfg || !cachedRuntime) {
    console.log("[STEER] No cached cfg/runtime available, cannot inject");
    logger.error("[STEER] No cached cfg/runtime available, cannot inject");
    return false;
  }

  // 3. 构造合成 A2A 消息（伪装成用户在当前会话中发送的新消息）
  const syntheticMessage = {
    jsonrpc: "2.0" as const,
    method: "tasks/send",
    id: `steer-msg-${randomUUID()}`,
    params: {
      sessionId,
      id: activeTaskId ?? `steer-task-${randomUUID()}`,
      agentLoginSessionId: "",
      message: {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: message }],
      },
    },
  };

  console.log(`[STEER] Injecting steer for sessionId=${sessionId}, taskId=${syntheticMessage.params.id}`);
  console.log(`[STEER] Synthetic message: ${JSON.stringify(syntheticMessage)}`);

  try {
    // 4. 走完整 handleXYMessage 流程
    //    由于 hasActiveTask(sessionId)=true，会自动触发 isSecondMessage=true 的 steer 模式
    await handleXYMessage({
      cfg: cachedCfg,
      runtime: cachedRuntime,
      message: syntheticMessage as any,
      accountId: cachedAccountId,
    });

    console.log(`[STEER] Steer injected successfully for sessionId=${sessionId}`);
    return true;
  } catch (err) {
    console.log(`[STEER] Failed to inject steer: ${err}`);
    logger.error(`[STEER] ❌ Failed to inject steer: ${err}`);
    return false;
  }
}
