import { readFileSync, writeFileSync } from "fs";

const XIAOYIENV_PATH = "/home/sandbox/.openclaw/.xiaoyienv";

export function handleSelfEvolutionEvent(context: any, runtime: any): void {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  try {
    const state = context.event?.payload?.selfEvolutionState;
    if (typeof state !== "string") {
      error("[SELF_EVOLUTION] invalid payload: missing selfEvolutionState");
      return;
    }

    log(`[SELF_EVOLUTION] received state: ${state}`);

    let content: string;
    try {
      content = readFileSync(XIAOYIENV_PATH, "utf-8");
    } catch {
      // File doesn't exist yet — create it
      log(`[SELF_EVOLUTION] ${XIAOYIENV_PATH} not found, creating new file`);
      writeFileSync(XIAOYIENV_PATH, `selfEvolutionState=${state}\n`, "utf-8");
      log(`[SELF_EVOLUTION] wrote selfEvolutionState=${state}`);
      return;
    }

    const lines = content.split("\n");
    const key = "selfEvolutionState";
    let found = false;

    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${state}`;
      }
      return line;
    });

    if (!found) {
      // Ensure trailing newline before appending
      const trimmed = content.trimEnd();
      writeFileSync(XIAOYIENV_PATH, `${trimmed}\n${key}=${state}\n`, "utf-8");
    } else {
      writeFileSync(XIAOYIENV_PATH, updated.join("\n"), "utf-8");
    }

    log(`[SELF_EVOLUTION] updated selfEvolutionState=${state} in ${XIAOYIENV_PATH}`);
  } catch (err) {
    error("[SELF_EVOLUTION] failed to handle event:", err);
  }
}
