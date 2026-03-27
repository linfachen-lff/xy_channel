// Thread-binding implementation for Xiaoyi Channel
// Simplified from feishu implementation for single-account mode
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/text-runtime";

type XYBindingTargetKind = "subagent" | "session";

/**
 * Xiaoyi thread binding record.
 * Simplified from feishu - uses sessionId as conversationId, no parentConversationId.
 */
type XYThreadBindingRecord = {
  accountId: string;
  sessionId: string;  // Equivalent to conversationId in Xiaoyi context
  targetKind: XYBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  boundAt: number;
  lastActivityAt: number;
};

/**
 * Thread binding manager for Xiaoyi channel.
 * Manages session bindings for single-account mode.
 */
type XYThreadBindingManager = {
  accountId: string;
  getBySessionId: (sessionId: string) => XYThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => XYThreadBindingRecord[];
  bindSession: (params: {
    sessionId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => XYThreadBindingRecord | null;
  touchSession: (sessionId: string, at?: number) => XYThreadBindingRecord | null;
  unbindSession: (sessionId: string) => XYThreadBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => XYThreadBindingRecord[];
  stop: () => void;
};

type XYThreadBindingsState = {
  managersByAccountId: Map<string, XYThreadBindingManager>;
  bindingsByAccountSession: Map<string, XYThreadBindingRecord>;
};

const XY_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.xyThreadBindingsState");
const state = resolveGlobalSingleton<XYThreadBindingsState>(
  XY_THREAD_BINDINGS_STATE_KEY,
  () => ({
    managersByAccountId: new Map(),
    bindingsByAccountSession: new Map(),
  }),
);

function getState(): XYThreadBindingsState {
  return state;
}

function resolveBindingKey(params: { accountId: string; sessionId: string }): string {
  return `${params.accountId}:${params.sessionId}`;
}

function toSessionBindingTargetKind(raw: XYBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toXYTargetKind(raw: BindingTargetKind): XYBindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toSessionBindingRecord(
  record: XYThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const idleExpiresAt =
    defaults.idleTimeoutMs > 0 ? record.lastActivityAt + defaults.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = defaults.maxAgeMs > 0 ? record.boundAt + defaults.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);

  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      sessionId: record.sessionId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "xiaoyi-channel",
      accountId: record.accountId,
      conversationId: record.sessionId,  // sessionId is the conversationId for Xiaoyi
      parentConversationId: undefined,  // Xiaoyi doesn't have parent conversations
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt,
    metadata: {
      agentId: record.agentId,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: defaults.idleTimeoutMs,
      maxAgeMs: defaults.maxAgeMs,
    },
  };
}

/**
 * Creates a thread binding manager for Xiaoyi channel.
 * Based on feishu implementation but simplified for single-account mode.
 */
export function createXYThreadBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): XYThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: "xiaoyi-channel",
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: "xiaoyi-channel",
    accountId,
  });

  const manager: XYThreadBindingManager = {
    accountId,
    getBySessionId: (sessionId) =>
      getState().bindingsByAccountSession.get(
        resolveBindingKey({ accountId, sessionId }),
      ),
    listBySessionKey: (targetSessionKey) =>
      [...getState().bindingsByAccountSession.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    bindSession: ({
      sessionId,
      targetKind,
      targetSessionKey,
      metadata,
    }) => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId || !targetSessionKey.trim()) {
        return null;
      }
      const now = Date.now();
      const record: XYThreadBindingRecord = {
        accountId,
        sessionId: normalizedSessionId,
        targetKind: toXYTargetKind(targetKind),
        targetSessionKey: targetSessionKey.trim(),
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : resolveAgentIdFromSessionKey(targetSessionKey),
        boundAt: now,
        lastActivityAt: now,
      };
      getState().bindingsByAccountSession.set(
        resolveBindingKey({ accountId, sessionId: normalizedSessionId }),
        record,
      );
      return record;
    },
    touchSession: (sessionId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, sessionId });
      const existingRecord = getState().bindingsByAccountSession.get(key);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      getState().bindingsByAccountSession.set(key, updated);
      return updated;
    },
    unbindSession: (sessionId) => {
      const key = resolveBindingKey({ accountId, sessionId });
      const existingRecord = getState().bindingsByAccountSession.get(key);
      if (!existingRecord) {
        return null;
      }
      getState().bindingsByAccountSession.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: XYThreadBindingRecord[] = [];
      for (const record of [...getState().bindingsByAccountSession.values()]) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        getState().bindingsByAccountSession.delete(
          resolveBindingKey({ accountId, sessionId: record.sessionId }),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      for (const key of [...getState().bindingsByAccountSession.keys()]) {
        if (key.startsWith(`${accountId}:`)) {
          getState().bindingsByAccountSession.delete(key);
        }
      }
      getState().managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: "xiaoyi-channel",
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "xiaoyi-channel",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "xiaoyi-channel" || input.placement === "child") {
        return null;
      }
      const bound = manager.bindSession({
        sessionId: input.conversation.conversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return bound ? toSessionBindingRecord(bound, { idleTimeoutMs, maxAgeMs }) : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "xiaoyi-channel") {
        return null;
      }
      const found = manager.getBySessionId(ref.conversationId);
      return found ? toSessionBindingRecord(found, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const sessionId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (sessionId) {
        manager.touchSession(sessionId, at);
      }
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager
          .unbindBySessionKey(input.targetSessionKey.trim())
          .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const sessionId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!sessionId) {
        return [];
      }
      const removed = manager.unbindSession(sessionId);
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  getState().managersByAccountId.set(accountId, manager);
  return manager;
}

/**
 * Gets the thread binding manager for a given account ID.
 */
export function getXYThreadBindingManager(
  accountId?: string,
): XYThreadBindingManager | null {
  return getState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

/**
 * Testing utilities for thread bindings.
 */
export const __testing = {
  resetXYThreadBindingsForTests() {
    for (const manager of getState().managersByAccountId.values()) {
      manager.stop();
    }
    getState().managersByAccountId.clear();
    getState().bindingsByAccountSession.clear();
  },
};
