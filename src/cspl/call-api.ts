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

  // 打印请求信息
  console.log(`[CSPL API] ==================== 发起请求 ====================`);
  console.log(`[CSPL API] URL: ${config.api.url}`);
  console.log(`[CSPL API] Method: POST`);
  console.log(`[CSPL API] Headers:`);
  console.log(`[CSPL API]   - x-hag-trace-id: ${headers["x-hag-trace-id"]}`);
  console.log(`[CSPL API]   - x-uid: ${headers["x-uid"]}`);
  console.log(`[CSPL API]   - x-api-key: ${headers["x-api-key"] ? "***" + headers["x-api-key"].slice(-8) : "undefined"}`);
  console.log(`[CSPL API]   - x-request-from: ${headers["x-request-from"]}`);
  console.log(`[CSPL API]   - x-skill-id: ${headers["x-skill-id"]}`);
  console.log(`[CSPL API]   - content-type: ${headers["content-type"]}`);
  console.log(`[CSPL API] Body:`);
  console.log(`[CSPL API]   - questionText: ${questionText.substring(0, 100)}${questionText.length > 100 ? "..." : ""}`);
  console.log(`[CSPL API]   - textSource: ${payload.textSource}`);
  console.log(`[CSPL API]   - action: ${payload.action}`);
  console.log(`[CSPL API] =================================================`);

  return new Promise((resolve, reject) => {
    const options = buildRequestOptions(
      config.api.url,
      headers,
      config.api.timeout,
    );

    const req = https.request(options, (res) => {
      console.log(`[CSPL API] Response Status: ${res.statusCode}`);
      console.log(`[CSPL API] Response Headers: ${JSON.stringify(res.headers)}`);

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
          const result = parseResponse(data);
          console.log(`[CSPL API] ✅ 请求成功`);
          console.log(`[CSPL API] Response Body: ${data.substring(0, 200)}${data.length > 200 ? "..." : ""}`);
          console.log(`[CSPL API] =================================================`);
          resolve(result);
        } catch (e) {
          console.error(`[CSPL API] ❌ 请求失败: ${e instanceof Error ? e.message : String(e)}`);
          console.error(`[CSPL API] Response Body: ${data}`);
          reject(e);
        }
      });
    });

    req.on("error", (error) => {
      console.error(`[CSPL API] ❌ 请求错误: ${error instanceof Error ? error.message : String(error)}`);
      reject(error);
    });
    req.on("timeout", () => {
      console.error(`[CSPL API] ⏰ 请求超时 (${config.api.timeout}ms)`);
      req.destroy();
      reject(new Error("[CSPL] Request timeout"));
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}
