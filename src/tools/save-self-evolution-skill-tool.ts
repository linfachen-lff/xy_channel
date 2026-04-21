import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCurrentSessionContext } from "./session-manager.js";
import { selfEvolutionManager } from "../utils/self-evolution-manager.js";

const SELF_EVOLVED_SKILL_ROOT = "/home/sandbox/.openclaw/skills/self-evolved";

function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function containsSensitiveContent(text: string): boolean {
  const lower = text.toLowerCase();
  const sensitivePatterns = [
    /api[_ -]?key/u,
    /access[_ -]?token/u,
    /bearer\s+[a-z0-9._-]+/iu,
    /password/u,
    /secret/u,
    /\/home\/sandbox\//u,
    /\/tmp\//u,
    /[a-z]:\\/iu,
  ];
  return sensitivePatterns.some((pattern) => pattern.test(lower));
}

function buildSkillMarkdown(params: {
  title: string;
  summary: string;
  whenToUse: string;
  rules: string[];
  examples: string[];
  tags: string[];
}): string {
const description = `${params.summary}\n\nWhen to use: ${params.whenToUse}`
  .replace(/"/g, '\\"')
  .replace(/\r?\n/g, "\\n");

const lines: string[] = [
  "---",
  `name: "${params.title.replace(/"/g, '\\"')}"`,
  `description: "${description}"`,
  "---",
  "",
  `# ${params.title}`,
  "",
  "## Rules",
];


  for (const rule of params.rules) {
    lines.push(`- ${rule}`);
  }

  if (params.examples.length > 0) {
    lines.push("", "## Examples");
    for (const example of params.examples) {
      lines.push(`- ${example}`);
    }
  }

  if (params.tags.length > 0) {
    lines.push("", "## Tags", params.tags.map((tag) => `- ${tag}`).join("\n"));
  }

  lines.push("");
  return lines.join("\n");
}

export const saveSelfEvolutionSkillTool: any = {
  name: "save_self_evolution_skill",
  label: "Save Self Evolution Skill",
  description:
    "将可复用的经验/脚本/教训等保存为skill技能，供下次执行类似任务时参考。仅用于通用、可复用的场景。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short, reusable title for the learned skill.",
      },
      summary: {
        type: "string",
        description: "One-sentence summary of the lesson.",
      },
      when_to_use: {
        type: "string",
        description: "Describe when this skill should be applied in future tasks.",
      },
      rules: {
        type: "array",
        items: { type: "string" },
        description: "Concrete, reusable rules or checklist items.",
      },
      examples: {
        type: "array",
        items: { type: "string" },
        description: "Optional examples of the pitfall and the correct pattern.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for future discovery.",
      },
    },
    required: ["title", "summary", "when_to_use", "rules"],
  },

  async execute(_toolCallId: string, params: any) {
    if (!selfEvolutionManager.isEnabled()) {
      throw new Error("Self-evolution is currently disabled by the user.");
    }

    const sessionContext = getCurrentSessionContext();
    if (!sessionContext) {
      throw new Error("No active XY session found. This tool can only run during an active conversation.");
    }

    const title = typeof params.title === "string" ? params.title.trim() : "";
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    const whenToUse =
      typeof params.when_to_use === "string" ? params.when_to_use.trim() : "";
    const rules = normalizeStringArray(params.rules);
    const examples = normalizeStringArray(params.examples);
    const tags = normalizeStringArray(params.tags);

    if (!title || !summary || !whenToUse || rules.length === 0) {
      throw new Error("Missing required fields. title, summary, when_to_use, and at least one rule are required.");
    }

    if (title.length < 6 || summary.length < 10 || whenToUse.length < 10) {
      throw new Error("Skill content is too short. Provide a reusable title, summary, and usage guidance.");
    }

    const combinedText = [title, summary, whenToUse, ...rules, ...examples, ...tags].join("\n");
    if (containsSensitiveContent(combinedText)) {
      throw new Error("Skill content appears to contain sensitive or environment-specific data and was rejected.");
    }

    const slug = slugifyTitle(title);
    if (!slug) {
      throw new Error("Title could not be normalized into a valid skill name.");
    }

    const skillDir = path.join(SELF_EVOLVED_SKILL_ROOT, slug);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const nextContent = buildSkillMarkdown({
      title,
      summary,
      whenToUse,
      rules,
      examples,
      tags,
    });
    const nextHash = createHash("sha256").update(nextContent).digest("hex");

    await fs.mkdir(skillDir, { recursive: true });

    try {
      const existingContent = await fs.readFile(skillFilePath, "utf-8");
      const existingHash = createHash("sha256").update(existingContent).digest("hex");
      if (existingHash === nextHash) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                deduped: true,
                skillName: slug,
                path: skillFilePath,
                message: "An identical self-evolved skill already exists.",
              }),
            },
          ],
        };
      }
      throw new Error(`A different skill with the same title already exists: ${skillFilePath}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.writeFile(skillFilePath, nextContent, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            deduped: false,
            skillName: slug,
            path: skillFilePath,
            sessionId: sessionContext.sessionId,
            message: "Self-evolved skill saved successfully.",
          }),
        },
      ],
    };
  },
};
