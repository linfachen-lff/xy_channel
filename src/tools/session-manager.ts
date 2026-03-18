// Session manager for XY tool context
// Stores active session contexts that tools can access
import { AsyncLocalStorage } from "async_hooks";
import type { XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";

export interface SessionContext {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
}

interface SessionContextWithRef extends SessionContext {
  refCount: number;  // 引用计数
}

// Map of sessionKey -> SessionContextWithRef
const activeSessions = new Map<string, SessionContextWithRef>();

// AsyncLocalStorage for thread-safe session context isolation
const asyncLocalStorage = new AsyncLocalStorage<SessionContext>();

/**
 * Register a session context for tool access.
 * Should be called when starting to process a message.
 */
export function registerSession(sessionKey: string, context: SessionContext): void {
  logger.log(`[SESSION_MANAGER] 📝 Registering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  logger.log(`[SESSION_MANAGER]   - taskId: ${context.taskId}`);
  logger.log(`[SESSION_MANAGER]   - messageId: ${context.messageId}`);
  logger.log(`[SESSION_MANAGER]   - agentId: ${context.agentId}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${activeSessions.size}`);

  const existing = activeSessions.get(sessionKey);
  if (existing) {
    // 更新上下文，增加引用计数
    existing.taskId = context.taskId;
    existing.messageId = context.messageId;
    existing.refCount++;
    logger.log(`[SESSION_MANAGER]   - Updated existing, refCount=${existing.refCount}`);
  } else {
    // 新建
    activeSessions.set(sessionKey, {
      ...context,
      refCount: 1,
    });
    logger.log(`[SESSION_MANAGER]   - Created new, refCount=1`);
  }

  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - All session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string): void {
  logger.log(`[SESSION_MANAGER] 🗑️  Unregistering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Session existed: ${activeSessions.has(sessionKey)}`);

  const existing = activeSessions.get(sessionKey);
  if (!existing) {
    logger.log(`[SESSION_MANAGER]   - Session not found`);
    return;
  }

  existing.refCount--;
  logger.log(`[SESSION_MANAGER]   - Decremented refCount: ${existing.refCount}`);

  if (existing.refCount <= 0) {
    activeSessions.delete(sessionKey);
    configManager.clearSession(existing.sessionId);
    logger.log(`[SESSION_MANAGER]   - Deleted (refCount=0)`);
  }

  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Remaining session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting session by key: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions: ${activeSessions.size}`);

  const contextWithRef = activeSessions.get(sessionKey) ?? null;

  logger.log(`[SESSION_MANAGER]   - Found: ${contextWithRef !== null}`);
  if (contextWithRef) {
    logger.log(`[SESSION_MANAGER]   - sessionId: ${contextWithRef.sessionId}`);
    // 返回时去掉refCount字段
    const { refCount, ...context } = contextWithRef;
    return context;
  }

  return null;
}

/**
 * Get the most recent session context.
 * @deprecated Use getCurrentSessionContext() instead for thread-safe access.
 * This is a fallback for tools that don't have access to sessionKey.
 * Returns null if no sessions are active.
 */
export function getLatestSessionContext(): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting latest session context`);
  logger.log(`[SESSION_MANAGER]   - Active sessions count: ${activeSessions.size}`);
  logger.log(`[SESSION_MANAGER]   - Active session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);

  if (activeSessions.size === 0) {
    logger.error(`[SESSION_MANAGER]   - ❌ No active sessions found!`);
    return null;
  }

  // Return the last added session
  const sessions = Array.from(activeSessions.values());
  const latestSessionWithRef = sessions[sessions.length - 1];

  logger.log(`[SESSION_MANAGER]   - ✅ Found latest session:`);
  logger.log(`[SESSION_MANAGER]     - sessionId: ${latestSessionWithRef.sessionId}`);
  logger.log(`[SESSION_MANAGER]     - taskId: ${latestSessionWithRef.taskId}`);
  logger.log(`[SESSION_MANAGER]     - messageId: ${latestSessionWithRef.messageId}`);

  // 返回时去掉refCount字段
  const { refCount, ...latestSession } = latestSessionWithRef;
  return latestSession;
}

/**
 * Run a callback with a session context stored in AsyncLocalStorage.
 * This ensures thread-safe context isolation for concurrent requests.
 */
export function runWithSessionContext<T>(
  context: SessionContext,
  callback: () => Promise<T>
): Promise<T> {
  logger.log(`[SESSION_MANAGER] 🔐 Running with AsyncLocalStorage context`);
  logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  logger.log(`[SESSION_MANAGER]   - taskId: ${context.taskId}`);
  return asyncLocalStorage.run(context, callback);
}

/**
 * Get the current session context from AsyncLocalStorage.
 * This is the recommended way to access session context in tools.
 * Returns null if not running within a session context.
 */
export function getCurrentSessionContext(): SessionContext | null {
  const context = asyncLocalStorage.getStore() ?? null;

  if (context) {
    logger.log(`[SESSION_MANAGER] ✅ Got current session context from AsyncLocalStorage`);
    logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
    logger.log(`[SESSION_MANAGER]   - taskId: ${context.taskId}`);
  } else {
    logger.warn(`[SESSION_MANAGER] ⚠️  No session context in AsyncLocalStorage`);
  }

  return context;
}
