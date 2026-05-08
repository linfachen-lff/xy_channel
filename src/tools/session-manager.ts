// Session manager for XY tool context
// Stores active session contexts that tools can access
import { AsyncLocalStorage } from "async_hooks";
import type { XYChannelConfig } from "../types.js";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";
import { toolCallNudgeManager } from "../utils/tool-call-nudge-manager.js";
import { getCurrentTaskId, getCurrentMessageId } from "../task-manager.js";

export interface SessionContext {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
  deviceType?: string;
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
    toolCallNudgeManager.clearSession(sessionKey);
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
 * Get the current session context.
 * Prefers AsyncLocalStorage (correct for concurrent sessions).
 * Falls back to the global activeSessions Map when AsyncLocalStorage
 * context is lost (e.g., pi-agent framework tool execution boundary).
 */
export function getCurrentSessionContext(): SessionContext | null {
  // 1. Try AsyncLocalStorage first (correct for concurrent sessions)
  const alsContext = asyncLocalStorage.getStore() ?? null;
  if (alsContext) {
    return enrichWithLatestTaskInfo(alsContext);
  }

  // 2. Fallback: look up from global activeSessions Map
  if (activeSessions.size === 0) {
    return null;
  }

  // 2a. Single active session — return it directly
  if (activeSessions.size === 1) {
    const entry = activeSessions.values().next().value;
    if (entry) {
      const { refCount, ...context } = entry;
      return enrichWithLatestTaskInfo(context);
    }
    return null;
  }

  // 2b. Multiple sessions — match by taskId currently being processed
  for (const entry of activeSessions.values()) {
    const latestTaskId = getCurrentTaskId(entry.sessionId);
    if (latestTaskId) {
      const { refCount, ...context } = entry;
      return enrichWithLatestTaskInfo(context);
    }
  }

  return null;
}

/**
 * Enrich a base session context with the latest taskId/messageId
 * from task-manager (supports interruption scenarios).
 */
function enrichWithLatestTaskInfo(context: SessionContext): SessionContext {
  const latestTaskId = getCurrentTaskId(context.sessionId);
  const latestMessageId = getCurrentMessageId(context.sessionId);

  if (latestTaskId && latestTaskId !== context.taskId) {
    return {
      ...context,
      taskId: latestTaskId,
      messageId: latestMessageId ?? context.messageId,
    };
  }

  return context;
}
