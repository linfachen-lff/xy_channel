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

  const existing = activeSessions.get(sessionKey);
  if (existing) {
    // 更新上下文，增加引用计数
    existing.taskId = context.taskId;
    existing.messageId = context.messageId;
    existing.refCount++;
  } else {
    // 新建
    activeSessions.set(sessionKey, {
      ...context,
      refCount: 1,
    });
  }

}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string): void {

  const existing = activeSessions.get(sessionKey);
  if (!existing) {
    return;
  }

  existing.refCount--;

  if (existing.refCount <= 0) {
    activeSessions.delete(sessionKey);
    configManager.clearSession(existing.sessionId);
  }

}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {

  const contextWithRef = activeSessions.get(sessionKey) ?? null;

  if (contextWithRef) {
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

  if (activeSessions.size === 0) {
    return null;
  }

  // Return the last added session
  const sessions = Array.from(activeSessions.values());
  const latestSessionWithRef = sessions[sessions.length - 1];


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
  return asyncLocalStorage.run(context, callback);
}

/**
 * Get the current session context from AsyncLocalStorage.
 * This is the recommended way to access session context in tools.
 * Returns null if not running within a session context.
 *
 * 每条消息通过 runWithSessionContext 绑定自己的 taskId，
 * 工具直接使用当前 AsyncLocalStorage 中的原始上下文，
 * 不再动态切换到最新 taskId，避免 steer 打断时 taskId 串台。
 */
export function getCurrentSessionContext(): SessionContext | null {
  return asyncLocalStorage.getStore() ?? null;
}
