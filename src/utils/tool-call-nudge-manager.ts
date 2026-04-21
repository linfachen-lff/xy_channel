type ToolCallNudgeState = {
  count: number;
  nudged: boolean;
};

type RecordToolCallResult = {
  count: number;
  shouldNudge: boolean;
};

// 暂时调低，便于测试
const DEFAULT_TOOL_CALL_NUDGE_THRESHOLD = 2;

class ToolCallNudgeManager {
  private readonly threshold: number;
  private readonly sessions = new Map<string, ToolCallNudgeState>();

  constructor(threshold = DEFAULT_TOOL_CALL_NUDGE_THRESHOLD) {
    this.threshold = threshold;
  }

  recordToolCall(sessionKey: string): RecordToolCallResult {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = {
        count: 0,
        nudged: false,
      };
      this.sessions.set(sessionKey, state);
    }

    state.count += 1;

    if (!state.nudged && state.count >= this.threshold) {
      state.nudged = true;
      return {
        count: state.count,
        shouldNudge: true,
      };
    }

    return {
      count: state.count,
      shouldNudge: false,
    };
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

export const TOOL_CALL_NUDGE_THRESHOLD = DEFAULT_TOOL_CALL_NUDGE_THRESHOLD;
export const toolCallNudgeManager = new ToolCallNudgeManager();
