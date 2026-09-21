
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Default to the SGP cluster — that is the region whose /api/route/* endpoint
// serves the Desktop Preview models. Override with MIMO_ACCOUNT_REGION (e.g.
// "cn") when a connection belongs to a different cluster. The serviceToken
// cookie names are derived from this value, so a cluster switch stays coherent.
const MIMO_REGION = (process.env.MIMO_ACCOUNT_REGION || "sgp").toLowerCase();
const API_BASE = `https://mimo-server-${MIMO_REGION}.xiaomimimo.com`;
const ACCOUNT_HOST = "account.xiaomi.com";
const API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
const SSO_UA = "MiClaw/1.0";
const COOKIE_TTL_MS = 30 * 60 * 1000;

const _cache = new Map(); // key -> { cookie, at }
const _inflight = new Map(); // key -> Promise<cookie|null>

const DESKTOP_APP_FOLDER_NAMES = ["Xiaomi MiMo AI", "Xiaomi MiMo"];

function desktopCookiePathCandidates() {
  const home = os.homedir();
  return DESKTOP_APP_FOLDER_NAMES.map((appFolder) => {
    if (process.platform === "win32") {
      return path.join(home, "AppData", "Roaming", appFolder, "Partitions", "xiaomi-account", "Network", "Cookies");
    }
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", appFolder, "Partitions", "xiaomi-account", "Network", "Cookies");
    }
    return path.join(home, ".config", appFolder, "Partitions", "xiaomi-account", "Network", "Cookies");
  });
}

/**
 * Read the persisted Xiaomi account cookies from MiMo Desktop's Electron profile.
 * The Chromium cookie DB is held with an exclusive lock while Desktop runs, so we
 * copy it first and return null if that fails.
 * @returns {Promise<Record<string,string>|null>}
 */
async function readDesktopAccountCookies() {
  const src = desktopCookiePathCandidates().find((p) => fs.existsSync(p));
  if (!src) return null;
  const tmp = path.join(os.tmpdir(), `mimo-cookies-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`);
  try {
    fs.copyFileSync(src, tmp);
  } catch {
    return null; // locked by a running Desktop
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key = ?").all("." + ACCOUNT_HOST);
    db.close();
    const jar = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    return jar.passToken ? jar : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Read just the passToken + identity cookies from Desktop's profile.
 * Exported so the connect flow can persist a per-account passToken into the
 * connection's providerSpecificData — this is what enables multi-account rotation.
 * @returns {Promise<{passToken:string, userId:string|null, cUserId:string|null}|null>}
 */
export async function readDesktopPassToken() {
  try {
    const jar = await readDesktopAccountCookies();
    if (!jar?.passToken) return null;
    return { passToken: jar.passToken, userId: jar.userId || null, cUserId: jar.cUserId || null };
  } catch {
    return null;
  }
}

function signatureClientSign(nonce, ssecurity) {
  const input = `nonce=${nonce}` + (ssecurity && ssecurity.trim() ? `&${ssecurity}` : "");
  return encodeURIComponent(crypto.createHash("sha1").update(input).digest("base64"));
}

function absorbSetCookie(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m && m[2]) jar[m[1]] = m[2];
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ─── SSO handshake diagnostics (temporary) ──────────────────────────────────
// These log STRUCTURAL facts only — cookie names, statuses, presence flags,
// truncated URLs. Never secret values (passToken / serviceToken / ssecurity).
function ssoCookieNames(jar) {
  return Object.keys(jar || {}).filter((k) => jar[k]).join(",");
}
function ssoTruncUrl(u, n = 140) {
  if (typeof u !== "string" || !u) return "(none)";
  return u.length > n ? `${u.slice(0, n)}…[len=${u.length}]` : u;
}

/**
 * Exchange a passToken for a mimo-server service session cookie.
 * @param {object} passJar - passToken + identity cookies
 * @param {object|null} proxyOptions
 * @param {string} region - cluster to target (sgp | cn); drives API_BASE and
 *   the region-scoped cookie names emitted in the result.
 * @returns {Promise<string|null>} Cookie header value, or null on failure.
 */
async function acquireServiceCookie(passJar, proxyOptions, region = MIMO_REGION) {
  const apiBase = `https://mimo-server-${region}.xiaomimimo.com`;
  const jar = { ...passJar };
  const ck = () => cookieHeader(jar);

  console.log(
    `[MimoSSO] handshake start | API_BASE=${apiBase} | region=${region} | ` +
    `jarCookieNames=[${ssoCookieNames(jar)}] | passTokenLen=${jar.passToken ? String(jar.passToken).length : 0}`
  );

  // 1. Unauthenticated API call -> 302 carrying the sts callback (sid=mimopc)
  const r1 = await proxyAwareFetch(
    `${apiBase}/api/user/xiaomi/me`,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() } },
    proxyOptions,
  );
  const redirect = r1.headers.get("location");
  console.log(
    `[MimoSSO] step1 /api/user/xiaomi/me -> status=${r1.status} | ` +
    `hasLocation=${Boolean(redirect)} | location=${ssoTruncUrl(redirect)}`
  );
  if (!redirect) {
    console.log(`[MimoSSO] step1 FAILED: no Location header (302 expected) on ${apiBase}. Region mismatch or expired passToken likely.`);
    return null;
  }
  let stsCallback = null;
  try {
    stsCallback = new URL(redirect).searchParams.get("callback");
  } catch {
    console.log(`[MimoSSO] step1 FAILED: Location is not a parseable URL`);
    return null;
  }
  let stsHost = "(none)";
  try { stsHost = new URL(stsCallback).host; } catch { /* ignore */ }
  console.log(`[MimoSSO] step1 stsCallback=${stsCallback ? "present" : "MISSING"} | stsCallbackHost=${stsHost}`);
  if (!stsCallback) return null;

  // 2. passportapi SSO phase 1 -> nonce + ssecurity
  const sso1 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=passportapi&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" } },
    proxyOptions,
  );
  const sso1Text = (await sso1.text()).replace(/^&&&START&&&/, "");
  let j1 = {};
  try { j1 = JSON.parse(sso1Text); } catch { /* leave empty */ }
  const nonce = j1.nonce || (j1.location ? new URL(j1.location).searchParams.get("nonce") : null);
  console.log(
    `[MimoSSO] step2 passportapi -> status=${sso1.status} | parsed=${Boolean(j1 && Object.keys(j1).length)} | ` +
    `hasNonce=${Boolean(nonce)} | hasLocation=${Boolean(j1.location)} | ` +
    `locationHost=${j1.location ? (() => { try { return new URL(j1.location).host; } catch { return "(unparseable)"; } })() : "(none)"} | ` +
    `hasSsecurity=${Boolean(j1.ssecurity)} | jsonKeys=[${j1 ? Object.keys(j1).join(",") : ""}]`
  );
  if (!nonce || !j1.location) {
    console.log(`[MimoSSO] step2 FAILED: passportapi returned no nonce/location. passToken likely expired or not accepted by ${ACCOUNT_HOST}.`);
    return null;
  }

  // 3. passportapi SSO phase 2 -> account-level serviceToken
  const sso2 = await proxyAwareFetch(
    `${j1.location}&clientSign=${signatureClientSign(nonce, j1.ssecurity)}`,
    { redirect: "manual", headers: { Cookie: ck(), "User-Agent": SSO_UA } },
    proxyOptions,
  );
  const jarBefore2 = Object.keys(jar).length;
  absorbSetCookie(jar, sso2);
  console.log(
    `[MimoSSO] step3 clientSign -> status=${sso2.status} | ` +
    `cookiesAbsorbed=${Object.keys(jar).length - jarBefore2} | jarNames=[${ssoCookieNames(jar)}]`
  );

  // 4. mimopc SSO -> sts callback carrying a ticket
  const sso3 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=mimopc&callback=${encodeURIComponent(stsCallback)}&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" } },
    proxyOptions,
  );
  const sso3Text = (await sso3.text()).replace(/^&&&START&&&/, "");
  let j3 = {};
  try { j3 = JSON.parse(sso3Text); } catch { /* leave empty */ }
  const jarBefore3 = Object.keys(jar).length;
  absorbSetCookie(jar, sso3);
  const j3locMatches = Boolean(j3?.location && /\/api\/sts/.test(j3.location));
  console.log(
    `[MimoSSO] step4 mimopc -> status=${sso3.status} | parsed=${Boolean(j3 && Object.keys(j3).length)} | ` +
    `location=${ssoTruncUrl(j3.location)} | matchesApiSts=${j3locMatches} | ` +
    `cookiesAbsorbed=${Object.keys(jar).length - jarBefore3} | ` +
    `code=${JSON.stringify(j3?.code)} | result=${JSON.stringify(j3?.result)} | ` +
    `desc=${JSON.stringify(j3?.desc)} | description=${JSON.stringify(j3?.description)} | ` +
    `jsonKeys=[${j3 ? Object.keys(j3).join(",") : ""}]`
  );
  if (!j3?.location || !j3locMatches) {
    console.log(
      `[MimoSSO] step4 FAILED on region=${region}: mimopc did not return a /api/sts location. ` +
      `Xiaomi status code=${JSON.stringify(j3?.code)} result=${JSON.stringify(j3?.result)} ` +
      `desc=${JSON.stringify(j3?.desc)} description=${JSON.stringify(j3?.description)}`
    );
    return null;
  }

  // 5. sts callback -> Set-Cookie: serviceToken (mimopc scope)
  const sts = await proxyAwareFetch(
    j3.location,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() } },
    proxyOptions,
  );
  const jarBefore5 = Object.keys(jar).length;
  absorbSetCookie(jar, sts);
  console.log(
    `[MimoSSO] step5 sts callback -> status=${sts.status} | ` +
    `cookiesAbsorbed=${Object.keys(jar).length - jarBefore5} | jarNames=[${ssoCookieNames(jar)}] | ` +
    `serviceToken=${jar.serviceToken ? `present(len=${String(jar.serviceToken).length})` : "MISSING"}`
  );

  if (!jar.serviceToken) {
    console.log(`[MimoSSO] step5 FAILED on region=${region}: no serviceToken cookie set by the sts callback.`);
    return null;
  }
  // Live capture (2026-09-21, CN cluster) shows Xiaomi issues SID-scoped
  // identity cookies — `mimopc_ph` / `mimopc_slh` — NOT region-derived names
  // like `mimocn_ph`. The sid is "mimopc" (MiMo PC), independent of cluster.
  // Emit serviceToken + identity cookies + any mimo* cookie so the header
  // covers whichever naming Xiaomi used.
  const out = { serviceToken: jar.serviceToken };
  if (jar.userId) out.userId = jar.userId;
  if (jar.cUserId) out.cUserId = jar.cUserId;
  for (const k of Object.keys(jar)) {
    if (k.startsWith("mimo") && jar[k]) out[k] = jar[k];
  }
  console.log(
    `[MimoSSO] handshake done | region=${region} | emitted=[${ssoCookieNames(out)}]`
  );
  return { cookieHeader: cookieHeader(out), region };
}

/**
 * Get (and cache) the mimo-server account cookie.
 * @param {object|null} providerSpecificData - may carry `mimoPassToken` override
 */
async function getServiceCookie(providerSpecificData, proxyOptions) {
  const hasPsdPassToken = Boolean(providerSpecificData?.mimoPassToken);
  const passJar = hasPsdPassToken
    ? {
        passToken: providerSpecificData.mimoPassToken,
        userId: providerSpecificData.mimoUserId,
        cUserId: providerSpecificData.mimoCUserId,
      }
    : await readDesktopAccountCookies();
  console.log(
    `[MimoSSO] getServiceCookie | source=${hasPsdPassToken ? "providerSpecificData(3-cookie)" : "desktopCookieDb(full-jar)"} | ` +
    `jarCookieNames=[${ssoCookieNames(passJar)}] | passTokenLen=${passJar?.passToken ? String(passJar.passToken).length : 0}`
  );
  if (!passJar?.passToken) return { cookie: null, reason: "no-pass-token" };

  // One cached session per passToken — accounts/connections rotate independently.
  const key = crypto.createHash("sha256").update(passJar.passToken).digest("hex");

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < COOKIE_TTL_MS) {
    return { cookie: cached.cookie, region: cached.region };
  }

  // De-dupe concurrent handshakes for the same account: a burst of requests must
  // not each run the full 5-step SSO chain.
  const inflight = _inflight.get(key);
  if (inflight) {
    const result = await inflight;
    return result?.cookieHeader
      ? { cookie: result.cookieHeader, region: result.region }
      : { cookie: null, reason: "sso-failed" };
  }

  // Try the configured region first, then the alternate cluster. Live evidence
  // (2026-09-21) showed steps 1-3 succeeding on SGP but step 4 (mimopc) returning
  // no /api/sts location — the signature of an account provisioned on a different
  // cluster than API_BASE. The region flows through acquireServiceCookie so the
  // emitted cluster-scoped cookie names (mimosgp_* vs mimocn_*) stay coherent.
  const regions = Array.from(new Set([MIMO_REGION, MIMO_REGION === "sgp" ? "cn" : "sgp"]));

  const promise = (async () => {
    try {
      for (const region of regions) {
        const result = await acquireServiceCookie(passJar, proxyOptions, region);
        if (result?.cookieHeader) {
          console.log(`[MimoSSO] handshake succeeded on region=${region}`);
          return result;
        }
        if (region !== regions[regions.length - 1]) {
          console.log(`[MimoSSO] region=${region} failed at mimopc step — retrying handshake on region=${regions.find((r) => r !== region)}`);
        }
      }
      return null; // network/parse/authorization failure on every region
    } catch {
      return null; // network/parse failure — callers degrade, never throw
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);

  const result = await promise;
  if (!result?.cookieHeader) return { cookie: null, reason: "sso-failed" };
  _cache.set(key, { cookie: result.cookieHeader, region: result.region, at: Date.now() });
  return { cookie: result.cookieHeader, region: result.region };
}

/** Drop cached sessions so the next call re-runs the handshake (e.g. after a 401). */
export function invalidateMimoAccountCookieCache() {
  _cache.clear();
}

/** mimo-server account API base + the User-Agent its backend expects. */
export const MIMO_API_BASE = API_BASE;
export const MIMO_API_UA = API_UA;

// Headers observed from a real MiMo Desktop /api/route/chat/completions call
// (captured via HTTP Toolkit) — distinct from API_UA above, which is only
// for the SSO/account-service handshake. x-mimo-source in particular looks
// load-bearing: without it the backend returned membership_required even
// with a valid serviceToken cookie.
export const MIMO_CHAT_UA = "mimocode/desktop-cb00c28 ai-sdk/provider-utils/4.0.23 runtime/node.js/24";
export const MIMO_CHAT_SOURCE_HEADER = "mimocode-cli, mimocode-cli-free";
export const MIMO_CLIENT_VERSION = "26.912.121036";

/**
 * Resolve the mimo-server account-session cookie, for upstream /api/route/* calls.
 * Exposes the failure reason (unlike getMimoAccountCookie below) so callers can
 * tell "no passToken saved for this connection" apart from "the SSO handshake
 * failed even though a passToken is present" — these need very different
 * guidance and are easy to conflate into a misleading "sign in to Desktop"
 * message when the real problem is a handshake failure unrelated to Desktop.
 * @returns {Promise<{cookie: string|null, reason?: "no-pass-token"|"sso-failed"}>}
 */
export async function getMimoAccountSession(providerSpecificData = null, proxyOptions = null) {
  try {
    return await getServiceCookie(providerSpecificData, proxyOptions);
  } catch {
    return { cookie: null, reason: "sso-failed" };
  }
}

/**
 * Resolve the mimo-server account-session cookie, for upstream /api/route/* calls.
 * @deprecated collapses the failure reason — use getMimoAccountSession() where the
 * caller needs to distinguish "no passToken" from "handshake failed".
 * @returns {Promise<string|null>} Cookie header value, or null when unavailable.
 */
export async function getMimoAccountCookie(providerSpecificData = null, proxyOptions = null) {
  const { cookie } = await getMimoAccountSession(providerSpecificData, proxyOptions);
  return cookie;
}

/**
 * Fetch the weekly quota from the account service.
 * @returns {Promise<{percent?:number, resetDate?:string, resetAt?:number, error?:string}>}
 */
export async function getMimoAccountUsage(providerSpecificData = null, proxyOptions = null) {
  const { cookie, reason } = await getServiceCookie(providerSpecificData, proxyOptions);
  if (!cookie) {
    return { error: reason === "no-pass-token" ? "no-session" : "session-failed" };
  }
  try {
    const res = await proxyAwareFetch(
      `${API_BASE}/api/user/usage`,
      {
        headers: { "User-Agent": API_UA, Cookie: cookie, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      },
      proxyOptions,
    );
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) return { error: "bad-response" };
    return { percent: data.data.percent, resetDate: data.data.resetDate, resetAt: data.data.resetAt };
  } catch (e) {
    return { error: e.message };
  }
}
