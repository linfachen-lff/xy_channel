type SessionSelfEvolutionState = {
  promptPrimed: boolean;
  lastUserNoticeState: "enabled" | "disabled" | null;
};

export type SelfEvolutionState = {
  enabled: boolean;
  sessions: Map<string, SessionSelfEvolutionState>;
};

type ApplySelfEvolutionSignalResult = {
  enabled: boolean;
  justEnabled: boolean;
  justDisabled: boolean;
  promptPrimed: boolean;
};

class SelfEvolutionManager {
  private state: SelfEvolutionState = {
    enabled: false,
    sessions: new Map(),
  };

  private getSessionState(sessionId: string): SessionSelfEvolutionState {
    let sessionState = this.state.sessions.get(sessionId);
    if (!sessionState) {
      sessionState = {
        promptPrimed: false,
        lastUserNoticeState: null,
      };
      this.state.sessions.set(sessionId, sessionState);
    }
    return sessionState;
  }

  applySignal(sessionId: string, enabled: boolean | null): ApplySelfEvolutionSignalResult {
    const sessionState = this.getSessionState(sessionId);
    let justEnabled = false;
    let justDisabled = false;

    if (enabled === true) {
      const wasEnabled = this.state.enabled;
      this.state.enabled = true;
      sessionState.promptPrimed = true;
      if (!wasEnabled && sessionState.lastUserNoticeState !== "enabled") {
        justEnabled = true;
      }
      sessionState.lastUserNoticeState = "enabled";
    } else if (enabled === false) {
      const wasEnabled = this.state.enabled;
      this.state.enabled = false;
      if (wasEnabled && sessionState.lastUserNoticeState !== "disabled") {
        justDisabled = true;
      }
      sessionState.lastUserNoticeState = "disabled";
    }

    return {
      enabled: this.state.enabled,
      justEnabled,
      justDisabled,
      promptPrimed: sessionState.promptPrimed,
    };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  shouldInjectPrompt(sessionId?: string | null): boolean {
    if (!sessionId) {
      return false;
    }
    const sessionState = this.state.sessions.get(sessionId);
    return Boolean(sessionState?.promptPrimed);
  }

  clearSession(sessionId: string): void {
    this.state.sessions.delete(sessionId);
  }
}

export const selfEvolutionManager = new SelfEvolutionManager();
