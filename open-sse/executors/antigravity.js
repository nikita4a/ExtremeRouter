import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, ANTIGRAVITY_HEADERS, INTERNAL_REQUEST_HEADER, AG_DEFAULT_TOOLS, AG_TOOL_SUFFIX } from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "../config/providerOutputLimits.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { cleanJSONSchemaForAntigravity } from "../translator/formats/gemini.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../config/defaultThinkingSignature.js";

// Sanitize function name: Gemini requires [a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}
function sanitizeFunctionName(name) {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.substring(0, 64);
}

const MAX_RETRY_AFTER_MS = 10000;
const ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS = 15000;
const MAX_ANTIGRAVITY_OUTPUT_TOKENS = PROVIDER_MAX_OUTPUT_TOKENS.antigravity;
const SYSTEM_INSTRUCTION_CHAR_LIMIT = 4000;

const ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

const ANTIGRAVITY_TRANSIENT_STATUSES = new Set([
  HTTP_STATUS.SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
]);

// Fields Google generateContent rejects (Claude/OpenAI/Qwen thinking fields set at body root by thinkingUnified.js)
const ANTIGRAVITY_REQUEST_BLACKLIST = [
  "output_config",
  "thinking",
  "reasoning_effort",
  "reasoning",
  "enable_thinking",
  "thinking_budget",
  "thinkingConfig",
];

// Strip blacklisted fields from an object (used for both body.request and top-level body)
const stripBlacklisted = obj => {
  for (const key of ANTIGRAVITY_REQUEST_BLACKLIST) delete obj[key];
};

// Compress tool schemas to reduce request body size. Agents like Hermes send 31+
// tools with deeply nested schemas, producing 100KB+ request bodies — heavy token
// consumption that trips Google's per-IP TPM limits (429 RESOURCE_EXHAUSTED). This
// flattens schemas beyond MAX_SCHEMA_DEPTH to simple types, reducing body size by
// ~60-80% while preserving enough information for the model to call tools correctly.
const MAX_SCHEMA_DEPTH = 2;
const MAX_ANTIGRAVITY_TOOL_COUNT = 40;
const MAX_TOOL_DESC_CHARS = 200;
const MAX_SCHEMA_DESC_CHARS = 150;

function compressToolSchema(schema, depth) {
  if (!schema || typeof schema !== "object") return schema;

  // At max depth: collapse complex types to string with hint
  if (depth >= MAX_SCHEMA_DEPTH) {
    if (schema.type === "object" && schema.properties) {
      const propNames = Object.keys(schema.properties);
      return {
        type: "string",
        description: schema.description
          ? `${schema.description} (JSON object with: ${propNames.join(", ")})`
          : `JSON object with properties: ${propNames.join(", ")}`
      };
    }
    if (schema.type === "array" && schema.items) {
      return {
        type: "array",
        items: { type: schema.items.type || "string" }
      };
    }
    // Keep simple types as-is
    return schema;
  }

  // Within depth limit: recursively compress nested properties
  if (schema.type === "object" && schema.properties) {
    const compressed = { ...schema };
    compressed.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      compressed.properties[key] = compressToolSchema(val, depth + 1);
    }
    if (compressed.description && compressed.description.length > MAX_SCHEMA_DESC_CHARS) {
      compressed.description = compressed.description.substring(0, MAX_SCHEMA_DESC_CHARS - 3) + "...";
    }
    return compressed;
  }

  if (schema.type === "array" && schema.items) {
    return {
      ...schema,
      items: compressToolSchema(schema.items, depth + 1)
    };
  }

  // Trim description on leaf nodes
  if (schema.description && schema.description.length > MAX_SCHEMA_DESC_CHARS) {
    return { ...schema, description: schema.description.substring(0, MAX_SCHEMA_DESC_CHARS - 3) + "..." };
  }

  return schema;
}

// Image generation model name patterns
const IMAGE_MODEL_PATTERNS = [
  /image/i,
  /imagen/i,
  /image-generation/i,
];

// Detect if a model is an image generation model
function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some(p => p.test(model));
}

// Parse aspect ratio / resolution from model name suffixes
// e.g. "gemini-3.1-flash-image-16x9" -> { aspectRatio: "16:9" }
// e.g. "gemini-3.1-flash-image-1024x768" -> { aspectRatio: "4:3" }
function parseImageConfig(model) {
  const config = { aspectRatio: "1:1" };
  const resMatch = model.match(/(\d+)x(\d+)$/);
  if (resMatch) {
    const w = parseInt(resMatch[1]);
    const h = parseInt(resMatch[2]);
    if (w <= 16 && h <= 16) {
      config.aspectRatio = `${w}:${h}`;
    } else {
      // Resolution like 1024x768 — derive aspect ratio
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const d = gcd(w, h);
      config.aspectRatio = `${w/d}:${h/d}`;
    }
  }
  return config;
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    // Cached for parseError diagnostics on a bare/gateway-level rejection.
    this._lastRequestHost = baseUrl;
    // Image generation MUST use non-streaming generateContent
    const forceNonStream = isImageModel(model);
    const action = (stream && !forceNonStream) ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${baseUrl}/v1internal:${action}`;
  }

  // sessionId comes from transformRequest output; base.execute runs transformRequest before
  // buildHeaders, so we read it from instance state cached there (fallback: explicit arg).
  buildHeaders(credentials, stream = true, sessionId = null) {
    const sid = sessionId || this._lastSessionId;
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "User-Agent": this.config.headers?.["User-Agent"] || ANTIGRAVITY_HEADERS["User-Agent"],
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value,
      ...(sid && { "X-Machine-Session-Id": sid }),
      "Accept": stream ? "text/event-stream" : "application/json"
    };
  }

  /**
   * Antigravity-specific error parsing.
   *
   * Google's gateway/IAM layer rejects some requests with a BARE status and an
   * empty body (no JSON error payload). BaseExecutor.parseError then degrades
   * that to the useless string "HTTP 403", which is exactly what landed in the
   * connection's lastError. Surface gateway-level diagnostics instead: which
   * host, which project id went out (and whether it was fabricated), and any
   * response headers Google left behind (IAM rejections sometimes carry
   * www-authenticate / x-goog-* / grpc-status details that the body omits).
   */
  parseError(response, bodyText) {
    const status = response?.status;
    const hasBody = typeof bodyText === "string" && bodyText.trim().length > 0;
    if (hasBody) {
      return { status, message: bodyText };
    }

    // Empty body → gateway-level rejection. Collect diagnostic headers only
    // (never echo the Authorization token or the raw key).
    const headerHints = [];
    if (response?.headers?.forEach) {
      response.headers.forEach((value, key) => {
        if (/^(www-authenticate|x-goog|x-request-id|grpc|server|via|cf-ray|date)$/i.test(key)) {
          headerHints.push(`${key}: ${String(value).slice(0, 160)}`);
        }
      });
    }

    const host = this._lastRequestHost || this.getBaseUrls?.()?.[0] || "unknown-host";
    const project = this._lastRequestProject;
    const projectNote = project
      ? `project='${project}'`
      : "project=(not captured)";
    const headerNote = headerHints.length
      ? ` headers=[${headerHints.join(" | ")}]`
      : " headers=(none captured)";

    return {
      status,
      message:
        `HTTP ${status} (empty body — gateway/IAM-level rejection, not an application error) ` +
        `host=${host} ${projectNote}${headerNote}`,
      rawBody: "",
    };
  }

  transformRequest(model, body, stream, credentials) {
    const storedProjectId = credentials?.projectId;
    const projectId = storedProjectId || this.generateProjectId();

    // A fabricated project id is NOT a provisioned Google project. It has been
    // observed to work most of the time on the canary host, but it is also
    // consistent with the intermittent, body-less 403s this provider returns
    // (gateway/IAM-level rejection). Make the condition visible instead of
    // silently shipping a random id.
    if (!storedProjectId) {
      dbg(
        "PROJECT",
        `antigravity: no stored projectId for ${credentials?.email || credentials?.connectionId || "connection"} — ` +
        `sending locally generated '${projectId}'. Google may reject this at the gateway with a bare 403. ` +
        `Provision a real id via loadCodeAssist/onboardUser (reconnect, or wait for the runtime projectId backfill).`
      );
    }
    // Cached for parseError diagnostics on a bare/gateway-level rejection.
    this._lastRequestProject = projectId;

    // ─── Image generation: completely different request structure ───
    if (isImageModel(model)) {
      const imageConfig = parseImageConfig(model);
      // Strip model name suffixes for the actual API model name
      const cleanModel = model.replace(/-(\d+)x(\d+)$/, "");

      // Build simplified contents — text-only, merge all user messages
      const contents = [];
      const srcContents = body.request?.contents || body.contents || [];
      for (const c of srcContents) {
        const textParts = (c.parts || []).filter(p => p.text !== undefined).map(p => ({ text: p.text }));
        if (textParts.length > 0) {
          contents.push({ role: c.role || "user", parts: textParts });
        }
      }

      const sessionId = resolveSessionId({
        headers: credentials?.rawHeaders,
        body,
        connectionId: credentials?.email || credentials?.connectionId,
        scope: "antigravity",
      });

      this._lastSessionId = sessionId;

      return {
        project: projectId,
        model: cleanModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: `agent-${crypto.randomUUID()}`,
        request: {
          contents,
          generationConfig: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192,
            imageConfig,
          },
          sessionId,
          // No tools, no systemInstruction, no safetySettings for image gen
        },
      };
    }

    // ─── Standard (non-image) request ───
    // Fix contents for Claude models via Antigravity
    const contents = body.request?.contents?.map(c => {
      let role = c.role;
      // functionResponse must be role "user" for Claude models
      if (c.parts?.some(p => p.functionResponse)) {
        role = "user";
      }
      // Strip thought-only parts, keep thoughtSignature on functionCall parts (Gemini 3+ requires it)
      const parts = c.parts?.filter(p => {
        if (p.thought && !p.functionCall) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });
      // Gemini 3+ rejects functionCall parts without thoughtSignature. Clients (Claude Code, IDE)
      // don't persist thoughtSignature in their history, so backfill the default signature on any
      // functionCall part that arrives without one.
      const needsBackfill = parts?.some(p => p.functionCall && !p.thoughtSignature) ?? false;
      if (role !== c.role || parts?.length !== c.parts?.length || needsBackfill) {
        return {
          ...c, role,
          parts: needsBackfill
            ? parts.map(p => (p.functionCall && !p.thoughtSignature)
                ? { ...p, thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE }
                : p)
            : parts,
        };
      }
      return c;
    });

    // Google Cloud Code rejects requests where the last content turn is from
    // the model ("Requests ending with a model turn are not supported"). This
    // happens when the client sends a conversation history that ends with an
    // assistant message (e.g. Claude Code sending the previous response as
    // context). Strip trailing model turns so the last entry is always user.
    if (Array.isArray(contents) && contents.length > 0) {
      while (contents.length > 1 && contents[contents.length - 1]?.role === "model") {
        contents.pop();
      }
    }

    // Sanitize tool schemas and function names before sending to Antigravity.
    let tools = body.request?.tools;

    if (tools && tools.length > 0) {
      // Merge all groups into a single functionDeclarations group (Gemini expects 1 group)
      const seenToolNames = new Set();
      const allDeclarations = [];
      for (const group of tools) {
        for (const fn of group.functionDeclarations || []) {
          const name = sanitizeFunctionName(fn.name);
          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);
          let cleanedParams;
          try {
            cleanedParams = fn.parameters
              ? cleanJSONSchemaForAntigravity(structuredClone(fn.parameters))
              : { type: "object", properties: { reason: { type: "string", description: "Brief explanation" } }, required: ["reason"] };
          } catch (schemaErr) {
            // Schema conversion crashed — fallback to a safe minimal schema so the request
            // still proceeds. This prevents the "fake 429" bug (#2877/#2884) where schema
            // conversion failures cause Google to return RESOURCE_EXHAUSTED.
            console.warn(`[9Router] Schema conversion failed for tool "${name}": ${schemaErr.message}. Using fallback schema.`);
            cleanedParams = {
              type: "object",
              properties: {
                ...Object.fromEntries(
                  Object.entries(fn.parameters?.properties || {}).map(([k, v]) => [k, { type: typeof v?.type === "string" ? v.type : "string", description: v?.description || "" }])
                ),
              },
              required: fn.parameters?.required?.filter(r => fn.parameters?.properties?.[r]) || [],
            };
            // Ensure we have at least one property
            if (Object.keys(cleanedParams.properties).length === 0) {
              cleanedParams.properties = { reason: { type: "string", description: "Brief explanation" } };
              cleanedParams.required = ["reason"];
            }
          }

          // Compress schemas to reduce body size: flatten nested objects to max depth 2,
          // strip verbose descriptions to a capped length, remove empty descriptions.
          // This can reduce a 100KB+ body (31 tools) to ~20-30KB, significantly reducing
          // token consumption against IP-level rate limits.
          cleanedParams = compressToolSchema(cleanedParams, 0);

          allDeclarations.push({
            ...fn,
            name,
            description: fn.description ? fn.description.substring(0, MAX_TOOL_DESC_CHARS) : "",
            parameters: cleanedParams,
          });
        }
      }

      // Prioritize AG native tools, then client order; cap at MAX_ANTIGRAVITY_TOOL_COUNT
      if (allDeclarations.length > MAX_ANTIGRAVITY_TOOL_COUNT) {
        const native = [];
        const custom = [];
        for (const decl of allDeclarations) {
          (AG_DEFAULT_TOOLS.has(decl.name) ? native : custom).push(decl);
        }
        const remaining = MAX_ANTIGRAVITY_TOOL_COUNT - native.length;
        const pruned = [...native, ...custom.slice(0, Math.max(0, remaining))];
        dbg("TOOLS", `Pruned ${allDeclarations.length} → ${pruned.length} tools for Antigravity (${native.length} native + ${Math.min(custom.length, remaining)} client)`);
        allDeclarations.length = 0;
        allDeclarations.push(...pruned);
      }

      const bodyEstimate = JSON.stringify(allDeclarations).length;
      dbg("TOOLS", `Processed ${allDeclarations.length} tool declarations for Antigravity (~${Math.round(bodyEstimate / 1024)}KB): [${Array.from(seenToolNames).slice(0, 10).join(", ")}${seenToolNames.size > 10 ? "..." : ""}]`);
      tools = allDeclarations.length > 0 ? [{ functionDeclarations: allDeclarations }] : [];
    }

    // Strip tools/toolConfig (handled separately) and blacklisted fields that Google rejects
    const { tools: _originalTools, toolConfig: _originalToolConfig, ...requestWithoutTools } = body.request || {};
    stripBlacklisted(requestWithoutTools);
    const generationConfig = { ...(requestWithoutTools.generationConfig || {}) };
    // Output ceiling is model-aware: 16384 is the conservative provider default,
    // but Gemini 3.x advertise 65536 (capabilities maxOutput) and thinking burns
    // the SAME budget — clamping -high runs to 16384 truncated every long answer
    // with finishReason=MAX_TOKENS before the response could complete. Only
    // KNOWN capability entries raise the ceiling — unknown models resolve to a
    // generic default-floor (64000) that the backend never agreed to.
    const modelAlias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    const outputCaps = getCapabilitiesForModel(modelAlias, model);
    const advertisedOutput = outputCaps?.known === true ? (Number(outputCaps.maxOutput) || 0) : 0;
    const outputCeiling = Math.max(MAX_ANTIGRAVITY_OUTPUT_TOKENS, advertisedOutput);
    if (generationConfig.maxOutputTokens > outputCeiling) {
      generationConfig.maxOutputTokens = outputCeiling;
    }

    const transformedRequest = {
      ...requestWithoutTools,
      generationConfig,
      ...(contents && { contents }),
      ...(tools && { tools }),
      sessionId: body.request?.sessionId || resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.email || credentials?.connectionId, scope: "antigravity" }),
      safetySettings: undefined,
      ...(tools?.length > 0 && { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } })
    };

    // Large system prompts cause 429 RESOURCE_EXHAUSTED on Google's systemInstruction
    // token limit. Embed into first user message content instead (matching antigravity-gateway).
    const sysInstr = transformedRequest.systemInstruction;
    if (sysInstr) {
      const sysText = sysInstr.parts?.map(p => p.text || "").join("") || "";
      if (sysText.length > SYSTEM_INSTRUCTION_CHAR_LIMIT) {
        const reqContents = transformedRequest.contents || [];
        const firstUserIdx = reqContents.findIndex(c => c.role === "user");
        if (firstUserIdx >= 0) {
          const existingText = reqContents[firstUserIdx].parts?.filter(p => p.text !== undefined).map(p => p.text).join("") || "";
          const otherParts = reqContents[firstUserIdx].parts?.filter(p => p.text === undefined) || [];
          reqContents[firstUserIdx] = {
            ...reqContents[firstUserIdx],
            parts: [
              { text: `[System Instructions]\n${sysText}\n\n[User Message]\n${existingText}` },
              ...otherParts,
            ],
          };
        } else {
          reqContents.unshift({ role: "user", parts: [{ text: sysText }] });
        }
        transformedRequest.contents = reqContents;
        delete transformedRequest.systemInstruction;
        dbg("TOOLS", `Embedded ${sysText.length} char system prompt into user content (exceeds ${SYSTEM_INSTRUCTION_CHAR_LIMIT} limit)`);
      }
    }

    // Strip blacklisted thinking fields from top-level body (set by thinkingUnified.js at root, not body.request)
    stripBlacklisted(body);

    this._lastSessionId = transformedRequest.sessionId; // cached for buildHeaders (base.execute order)

    // Wire model: the CodeAssist API must receive the real upstream model id, not
    // the router alias. Sending the alias (e.g. "gemini-3.7-flash-high") or a
    // parenthesized tier id returns 404 NOT_FOUND "Requested entity was not found."
    // (OmniRoute reference: "tier suffixes were speculative and caused 404"). The
    // plain upstream id is resolved via the registry upstreamModelId.
    const strippedModel = typeof model === "string" && model.includes("/") ? model.split("/").pop() : model;
    const wireModel = getModelUpstreamId(modelAlias, strippedModel) || strippedModel || model;

    return {
      ...body,
      project: projectId,
      model: wireModel,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent-${crypto.randomUUID()}`,
      request: transformedRequest
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        })
      }, proxyOptions);

      if (!response.ok) return null;

      const tokens = await response.json();
      log?.info?.("TOKEN", "Antigravity refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId
      };
    } catch (error) {
      log?.error?.("TOKEN", `Antigravity refresh error: ${error.message}`);
      return null;
    }
  }

  generateProjectId() {
    const adj = ["useful", "bright", "swift", "calm", "bold"][Math.floor(Math.random() * 5)];
    const noun = ["fuze", "wave", "spark", "flow", "core"][Math.floor(Math.random() * 5)];
    return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
  }

  generateSessionId() {
    return crypto.randomUUID() + Date.now().toString();
  }

  parseRetryHeaders(headers) {
    if (!headers?.get) return null;

    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        return diff > 0 ? diff : null;
      }
    }

    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (resetAfter) {
      const seconds = parseInt(resetAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    }

    const resetTimestamp = headers.get('x-ratelimit-reset');
    if (resetTimestamp) {
      const ts = parseInt(resetTimestamp, 10) * 1000;
      const diff = ts - Date.now();
      return diff > 0 ? diff : null;
    }

    return null;
  }

  // Parse retry time from Antigravity error message body
  // Format: "Your quota will reset after 2h7m23s" or "1h30m" or "45m" or "30s"
  parseRetryFromErrorMessage(errorMessage) {
    if (!errorMessage || typeof errorMessage !== "string") return null;

    const match = errorMessage.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return null;

    let totalMs = 0;
    if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000; // hours
    if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000; // minutes
    if (match[3]) totalMs += parseInt(match[3]) * 1000; // seconds

    return totalMs > 0 ? totalMs : null;
  }

  extractErrorMessage(errorJson, bodyText = "") {
    return [
      errorJson?.error?.message,
      errorJson?.message,
      errorJson?.error,
      bodyText,
    ].filter(Boolean).map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n");
  }

  isTransientAntigravityError(status, message) {
    if (status === HTTP_STATUS.RATE_LIMITED) return true;
    if (ANTIGRAVITY_TRANSIENT_STATUSES.has(status)) return true;
    return ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message || ""));
  }

  // Hook called by BaseExecutor.tryRetry: derive delay from Retry-After (header → body),
  // cap at MAX_RETRY_AFTER_MS, else retry transient Antigravity failures with backoff.
  // Return false to veto (fallback URL / final error).
  async computeRetryDelay(response, attempt) {
    let bodyText = "";
    let errorJson = null;
    let retryMs = this.parseRetryHeaders(response.headers);

    try {
      bodyText = await response.clone().text();
      errorJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // ignore parse errors → fall through to status/message based retry
    }

    const errorMessage = this.extractErrorMessage(errorJson, bodyText);

    if (!retryMs) {
      retryMs = this.parseRetryFromErrorMessage(errorMessage);
    }
    if (retryMs) return retryMs <= MAX_RETRY_AFTER_MS ? retryMs : false;

    if (!this.isTransientAntigravityError(response.status, errorMessage)) return false;

    const cap = response.status === HTTP_STATUS.RATE_LIMITED
      ? MAX_RETRY_AFTER_MS
      : ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS;
    return Math.min(1000 * (2 ** attempt), cap); // exponential backoff
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body, clientTool = null) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const isCopilot = clientTool === "github-copilot";
    const toolNameMap = new Map();
    const clientDeclarations = [];
    const decoyNames = new Set(AG_DECOY_TOOLS.map(tool => tool.name));

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // For GitHub Copilot, avoid emitting duplicate native Antigravity tool names.
        // Keep the decoys only once in the final declaration list.
        if (isCopilot && AG_DEFAULT_TOOLS.has(func.name)) {
          continue;
        }

        // Skip if already covered by decoys for Copilot
        if (isCopilot && decoyNames.has(func.name)) {
          continue;
        }

        // Preserve native AG names for non-Copilot clients
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [];
    const seenNames = new Set();
    for (const decl of [...clientDeclarations, ...AG_DECOY_TOOLS]) {
      if (!decl?.name || seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      allDeclarations.push(decl);
    }

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map(msg => {
      if (!msg.parts) return msg;
      
      const cloakedParts = msg.parts.map(part => {
        // Rename functionCall.name
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        // Rename functionResponse.name
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        return part;
      });
      
      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents
        }
      },
      toolNameMap
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

export default AntigravityExecutor;
