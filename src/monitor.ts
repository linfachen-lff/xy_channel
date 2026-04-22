// Monitor for XY channel WebSocket connections
// Follows feishu/monitor.account.ts and feishu/monitor.transport.ts pattern
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveXYConfig } from "./config.js";
import { getXYWebSocketManager, diagnoseAllManagers, cleanupOrphanConnections, removeXYWebSocketManager } from "./client.js";
import { handleXYMessage } from "./bot.js";
import { parseA2AMessage } from "./parser.js";
import { hasActiveTask } from "./task-manager.js";
import { handleTriggerEvent } from "./trigger-handler.js";
import { handleSelfEvolutionEvent } from "./self-evolution-handler.js";
import { handleLoginTokenEvent } from "./login-token-handler.js";
import { cleanupStaleTempFiles } from "./reply-dispatcher.js";

export type MonitorXYOpts = {
  config?: any;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (status: { lastEventAt?: number; lastInboundAt?: number; connected?: boolean }) => void;
};

/**
 * Per-session serial queue that ensures messages from the same session are processed
 * in arrival order while allowing different sessions to run concurrently.
 * Following feishu/monitor.account.ts pattern.
 */
function createSessionQueue() {
  const queues = new Map<string, Promise<void>>();
  return (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) {
        queues.delete(sessionId);
      }
    });
    return next;
  };
}

/**
 * Monitor XY channel WebSocket connections.
 * Keeps the connection alive until abortSignal is triggered.
 */
export async function monitorXYProvider(opts: MonitorXYOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for XY monitor");
  }

  const runtime = opts.runtime;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const account = resolveXYConfig(cfg);
  if (!account.enabled) {
    throw new Error(`XY account is disabled`);
  }

  const accountId = opts.accountId ?? "default";

  // Create trackEvent function to report health to OpenClaw framework
  const trackEvent = opts.setStatus
    ? () => {
        opts.setStatus!({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
      }
    : undefined;

  // 🔍 Diagnose WebSocket managers before gateway start
  console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers before gateway start...");
  diagnoseAllManagers();

  // Get WebSocket manager (cached)
  const wsManager = getXYWebSocketManager(account);

  // ✅ Set health event callback for heartbeat reporting
  if (trackEvent) {
    wsManager.setHealthEventCallback(trackEvent);
  }

  // Track logged servers to avoid duplicate logs
  const loggedServers = new Set<string>();

  // Track active message processing to detect duplicates
  const activeMessages = new Set<string>();

  // Create session queue for ordered message processing
  const enqueue = createSessionQueue();

  // Health check interval
  let healthCheckInterval: NodeJS.Timeout | null = null;

  return new Promise<void>((resolve, reject) => {
    // Event handlers (defined early so they can be referenced in cleanup)
    const messageHandler = (message: any, sessionId: string, serverId: string) => {
      const messageKey = `${sessionId}::${message.id}`;

      log(`[MONITOR-HANDLER] ####### messageHandler triggered: sessionId=${sessionId}, messageId=${message.id} #######`);

      // ✅ Report health: received a message
      trackEvent?.();

      // Check for duplicate message handling
      if (activeMessages.has(messageKey)) {
        error(`[MONITOR-HANDLER] ⚠️ WARNING: Duplicate message detected! messageKey=${messageKey}, this may cause duplicate dispatchers!`);
      }

      activeMessages.add(messageKey);

      const task = async () => {
        try {
          await handleXYMessage({
            cfg,
            runtime,
            message,
            accountId,  // ✅ Pass accountId ("default")
            webSocketSessionId: sessionId,  // ✅ 传递 WebSocket 层级的 sessionId
          });
        } catch (err) {
          // ✅ Only log error, don't re-throw to prevent gateway restart
          error(`XY gateway: error handling message from ${serverId}: ${String(err)}`);
        } finally {
          // Remove from active messages when done
          activeMessages.delete(messageKey);
        }
      };

      // 🔑 核心改造：检测steer模式
      // 需要提前解析消息以获取sessionId
      try {
        const parsed = parseA2AMessage(message);
        const steerMode = cfg.messages?.queue?.mode === "steer";
        const hasActiveRun = hasActiveTask(parsed.sessionId);

        if (steerMode && hasActiveRun) {
          // Steer模式且有活跃任务：不入队列，直接并发执行
          log(`[MONITOR-HANDLER] 🔄 STEER MODE: Executing concurrently for messageKey=${messageKey}`);
          log(`[MONITOR-HANDLER]   - sessionId: ${parsed.sessionId}`);
          void task().catch((err) => {
            error(`XY gateway: concurrent steer task failed for ${messageKey}: ${String(err)}`);
            activeMessages.delete(messageKey);
          });
        } else {
          // 正常模式：入队列串行执行
          void enqueue(sessionId, task).catch((err) => {
            error(`XY gateway: queue processing failed for session ${sessionId}: ${String(err)}`);
            activeMessages.delete(messageKey);
          });
        }
      } catch (parseErr) {
        // 解析失败，回退到正常队列模式
        error(`[MONITOR-HANDLER] Failed to parse message for steer detection: ${String(parseErr)}`);
        void enqueue(sessionId, task).catch((err) => {
          error(`XY gateway: queue processing failed for session ${sessionId}: ${String(err)}`);
          activeMessages.delete(messageKey);
        });
      }
    };

    const connectedHandler = (serverId: string) => {
      if (!loggedServers.has(serverId)) {
        log(`XY gateway: ${serverId} connected`);
        loggedServers.add(serverId);
      }
      // ✅ Report health: connection established
      trackEvent?.();
      opts.setStatus?.({ connected: true });
    };

    const disconnectedHandler = (serverId: string) => {
      console.warn(`XY gateway: ${serverId} disconnected`);
      loggedServers.delete(serverId);
      // ✅ Report disconnection status (only if all servers disconnected)
      if (loggedServers.size === 0) {
        opts.setStatus?.({ connected: false });
      }
    };

    const errorHandler = (err: Error, serverId: string) => {
      error(`XY gateway: ${serverId} error: ${String(err)}`);
    };

    const triggerEventHandler = (context: any) => {
      log(`[MONITOR] 📌 Received trigger-event, dispatching to handler...`);
      log(`[MONITOR]   - sessionId: ${context.sessionId}`);
      log(`[MONITOR]   - taskId: ${context.taskId}`);
      // 异步处理 Trigger 事件，不阻塞主流程
      handleTriggerEvent(context, cfg, runtime, accountId).catch((err) => {
        error(`[MONITOR] Failed to handle trigger-event:`, err);
      });
    };

    const selfEvolutionHandler = (context: any) => {
      log(`[MONITOR] Received self-evolution-event, dispatching to handler...`);
      handleSelfEvolutionEvent(context, runtime);
    };

    const loginTokenEventHandler = (context: any) => {
      log(`[MONITOR] Received login-token-event, dispatching to handler...`);
      handleLoginTokenEvent(context, runtime);
    };

    const cleanup = () => {
      log("XY gateway: cleaning up...");

      // 🔍 Diagnose before cleanup
      console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers before cleanup...");
      diagnoseAllManagers();

      // Stop health check interval
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        console.log("⏸️  Stopped periodic health check");
      }

      // Remove event handlers to prevent duplicate calls on gateway restart
      wsManager.off("message", messageHandler);
      wsManager.off("connected", connectedHandler);
      wsManager.off("disconnected", disconnectedHandler);
      wsManager.off("error", errorHandler);
      wsManager.off("trigger-event", triggerEventHandler);
      wsManager.off("self-evolution-event", selfEvolutionHandler);
      wsManager.off("login-token-event", loginTokenEventHandler);

      // ✅ Disconnect the wsManager to prevent connection leaks
      // This is safe because each gateway lifecycle should have clean connections
      wsManager.disconnect();

      // ✅ Remove manager from cache to prevent reusing dirty state
      removeXYWebSocketManager(account);

      loggedServers.clear();
      activeMessages.clear();
      log(`[MONITOR-HANDLER] 🧹 Cleanup complete, cleared active messages`);

      // 🔍 Diagnose after cleanup
      console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers after cleanup...");
      diagnoseAllManagers();
    };

    const handleAbort = () => {
      log("XY gateway: abort signal received, stopping");
      cleanup();
      log("XY gateway stopped");
      resolve();
    };

    if (opts.abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    opts.abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // Register event handlers (handlers are defined above in cleanup scope)
    wsManager.on("message", messageHandler);
    wsManager.on("connected", connectedHandler);
    wsManager.on("disconnected", disconnectedHandler);
    wsManager.on("error", errorHandler);
    wsManager.on("trigger-event", triggerEventHandler);
    wsManager.on("self-evolution-event", selfEvolutionHandler);
    wsManager.on("login-token-event", loginTokenEventHandler);

    // Start periodic health check (every 6 hours)
    console.log("🏥 Starting periodic health check (every 6 hours)...");
    healthCheckInterval = setInterval(() => {
      console.log("🏥 [HEALTH CHECK] Periodic WebSocket diagnostics...");
      diagnoseAllManagers();

      // Auto-cleanup orphan connections
      const cleaned = cleanupOrphanConnections();
      if (cleaned > 0) {
        console.log(`🧹 [HEALTH CHECK] Auto-cleaned ${cleaned} manager(s) with orphan connections`);
      }

      // Cleanup stale temp files (older than 24 hours)
      void cleanupStaleTempFiles();
    }, 6 * 60 * 60 * 1000); // 6 hours

    // Connect to WebSocket servers
    wsManager.connect()
      .then(() => {
        log("XY gateway: started successfully");
      })
      .catch((err) => {
        // Connection failed but don't reject - continue monitoring for reconnection
        error(`XY gateway: initial connection failed: ${String(err)}`);
        // Still resolve successfully so plugin starts
        resolve();
      });
  });
}
