import { DefaultExecutor } from "./default.js";
import {
  getMimoAccountSession,
  invalidateMimoAccountCookieCache,
  MIMO_API_BASE,
  MIMO_CHAT_UA,
  MIMO_CHAT_SOURCE_HEADER,
  MIMO_CLIENT_VERSION,
} from "../shared/mimoAccount.js";

const PREVIEW_MODELS = new Set(["mimo-x-pro-preview", "mimo-x-flash-preview"]);
const COOKIE_KEY = "__mimoAccountCookie";
// Region that the account-session handshake actually succeeded on. The
// module-level MIMO_API_BASE is only a fallback default — minting a session
// cookie on one cluster and calling another host is an automatic 401
// (live-observed: handshake succeeded on cn, chat went to sgp → 401).
const COOKIE_REGION_KEY = "__mimoAccountRegion";

function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export class XiaomiMimoExecutor extends DefaultExecutor {
  constructor() {
    super("xiaomi-mimo");
  }

  static isPreviewModel(model) {
    return PREVIEW_MODELS.has(bareModel(model));
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (XiaomiMimoExecutor.isPreviewModel(model)) {
      // Prefer the cluster that the handshake minted the session for.
      const region = credentials?.[COOKIE_REGION_KEY];
      const base = region
        ? `https://mimo-server-${region}.xiaomimimo.com`
        : MIMO_API_BASE;
      return `${base}/api/route/chat/completions`;
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, model, opencodeIdentity, urlIndex) {
    if (XiaomiMimoExecutor.isPreviewModel(model) && credentials?.[COOKIE_KEY]) {
      return {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": MIMO_CHAT_UA,
        "X-Mimo-Source": MIMO_CHAT_SOURCE_HEADER,
        "X-Client-Version": MIMO_CLIENT_VERSION,
        Cookie: credentials[COOKIE_KEY],
      };
    }
    return super.buildHeaders(credentials, stream, model, opencodeIdentity, urlIndex);
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (XiaomiMimoExecutor.isPreviewModel(model)) {
      if (out.thinking == null) out.thinking = { type: "enabled" };
      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
      if (!out.max_tokens) out.max_tokens = 4096;
    }

    return out;
  }

  async execute(args) {
    const { model, credentials, proxyOptions = null } = args;
    if (!XiaomiMimoExecutor.isPreviewModel(model)) return super.execute(args);

    const { cookie, reason, region } = await getMimoAccountSession(credentials?.providerSpecificData, proxyOptions);
    if (!cookie) {
      throw new Error(
        reason === "no-pass-token"
          ? "Xiaomi MiMo account session unavailable: no passToken is saved for this connection. Re-run the MiMo Desktop one-click import (with Desktop closed so its cookie file is readable), or sign in via browser instead."
          : "Xiaomi MiMo account session unavailable: the SSO handshake with Xiaomi's account servers failed even though a passToken is saved for this connection. This is unrelated to whether MiMo Desktop is currently open — the saved passToken may have expired, or the handshake itself is failing; re-importing from MiMo Desktop is the next thing to try.",
      );
    }
    credentials[COOKIE_KEY] = cookie;
    // Build the chat URL against the same cluster that minted the cookie.
    if (region) credentials[COOKIE_REGION_KEY] = region;
    const result = await super.execute(args);

    // A cached session can expire early — drop it and retry once with a fresh one.
    if (result?.response?.status === 401) {
      invalidateMimoAccountCookieCache();
      const fresh = await getMimoAccountSession(credentials?.providerSpecificData, proxyOptions).catch(() => ({
        cookie: null,
      }));
      if (fresh.cookie) {
        credentials[COOKIE_KEY] = fresh.cookie;
        if (fresh.region) credentials[COOKIE_REGION_KEY] = fresh.region;
        return super.execute(args);
      }
    }
    return result;
  }
}

export const __test__ = { PREVIEW_MODELS, bareModel, COOKIE_KEY, COOKIE_REGION_KEY };

export default XiaomiMimoExecutor;
