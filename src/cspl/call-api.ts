// CSPL API 请求模块

import https from "node:https";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getCsplConfig } from "./config.js";
import type { HttpHeaders, ApiPayload, ApiResponse } from "./constants.js";
import { DEFAULT_HTTP_PORT, HTTP_STATUS_BAD_REQUEST } from "./constants.js";

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function buildHeaders(config: ReturnType<typeof getCsplConfig>): HttpHeaders {
  return {
    "x-hag-trace-id": generateTraceId(),
    "x-uid": config.uid,
    "x-api-key": config.apiKey,
    "x-request-from": config.requestFrom,
    "x-skill-id": config.skillId,
    "content-type": "application/json",
  };
}

function buildRequestOptions(
  url: string,
  headers: HttpHeaders,
  timeout: number,
) {
  const urlObj = new URL(url);
  return {
    hostname: urlObj.hostname,
    port: urlObj.port || DEFAULT_HTTP_PORT,
    path: urlObj.pathname,
    method: "POST",
    headers: headers as unknown as Record<string, string>,
    timeout,
  };
}

function parseResponse(data: string): ApiResponse {
  if (!data?.trim()) throw new Error("[CSPL] API response is empty");
  const json = JSON.parse(data);
  if (json.retCode && json.retCode !== "0") {
    throw new Error(`[CSPL] API error: ${json.retMsg || "unknown"}`);
  }
  if (!json.retCode && json.code) {
    throw new Error(`[CSPL] Backend error: ${json.desc || "unknown"}`);
  }
  return json;
}

export async function callCsplApi(
  questionText: string,
  cfg: ClawdbotConfig,
): Promise<ApiResponse> {
  const config = getCsplConfig(cfg);
  const headers = buildHeaders(config);
  const payload: ApiPayload = {
    questionText,
    textSource: config.textSource,
    action: config.action,
  };

  return new Promise((resolve, reject) => {
    const options = buildRequestOptions(
      config.api.url,
      headers,
      config.api.timeout,
    );

    const req = https.request(options, (res) => {
      if (res.statusCode && res.statusCode >= HTTP_STATUS_BAD_REQUEST) {
        reject(new Error(`[CSPL] HTTP error: ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(parseResponse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("[CSPL] Request timeout"));
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}
