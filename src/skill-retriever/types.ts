export interface ToolRetrieverConfig {
  enabled: boolean;
  maxTools: number;
  includeUninstalledOnly: boolean;
  envFilePath: string;
  serviceUrl?: string;
  apiKey?: string;
  uid?: string;
  timeoutMs?: number;
}

export interface RawSkill {
  skillId: string;
  skillName: string;
  skillDesc: string;
  packUrl: string;
}

export interface FormattedSkill {
  skillId: string;
  skillName: string;
  skillDesc: string;
  downloadPath: string;
  status: "已安装" | "未安装";
}

export interface ToolSearchResult {
  tools: FormattedSkill[];
  query: string;
  timestamp: number;
}

export interface EnvConfig {
  PERSONAL_API_KEY?: string;
  PERSONAL_UID?: string;
  SERVICE_URL?: string;
  [key: string]: string | undefined;
}
