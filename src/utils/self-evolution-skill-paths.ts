import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_EVOLUTION_SKILLS_RELATIVE_DIR = path.join("skills", "self-evolution");

function findPluginRoot(startFileUrl: string): string {
  let current = path.dirname(fileURLToPath(startFileUrl));

  while (true) {
    const manifestPath = path.join(current, "openclaw.plugin.json");
    if (fs.existsSync(manifestPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate xiaoyi-channel plugin root from module path.");
    }
    current = parent;
  }
}

export function resolveSelfEvolutionSkillRoot(startFileUrl: string): string {
  return path.join(findPluginRoot(startFileUrl), SELF_EVOLUTION_SKILLS_RELATIVE_DIR);
}
