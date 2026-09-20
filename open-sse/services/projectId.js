/**
 * Project ID Service - Fetch and cache real Project IDs from Google Cloud Code API
 *
 *
 * Instead of generating random project IDs (e.g. "useful-spark-a1b2c"),
 * this service fetches the real Project ID bound to the authenticated user's account.
 * This significantly reduces the risk of being flagged by Google's anti-abuse systems.
 */

import { CLOUD_CODE_API, LOAD_CODE_ASSIST_HEADERS, ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_METADATA } from "../config/appConstants.js";

// ─── Cache ────────────────────────────────────────────────────────────────────
// connectionId -> { projectId: string, fetchedAt: number }
const projectIdCache = new Map();

/** How long a cached project ID is considered fresh (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

// ─── Negative cache (failure cooldown) ──────────────────────────────────────
// connectionId -> { failedAt: number }. A recent failed fetch (loadCodeAssist
// returned no project AND onboardUser exhausted its retries) is NOT re-attempted
// for FAILURE_COOLDOWN_MS. Without this, a provider that won't provision a
// project burns the full 5-attempt onboardUser (~10s) on EVERY request after a
// token refresh — the projectId never persists, so !refreshedCredentials.projectId
// stays true and the hot path re-fetches every time.
const projectIdFailures = new Map();
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

// ─── Pending-fetch deduplication ─────────────────────────────────────────────
// connectionId -> { promise: Promise<string|null>, controller: AbortController, startedAt: number }
const pendingFetches = new Map();

/** Abort and evict a pending fetch that has been running longer than this (2 min). */
const PENDING_TTL_MS = 2 * 60 * 1000;

// ─── Periodic cleanup ────────────────────────────────────────────────────────
/** How often the background sweep runs (10 min). */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let _cleanupTimer = null;

/** Run one sweep immediately: evict stale cache entries and abort orphaned pending fetches. */
export function cleanupNow() {
    const now = Date.now();

    for (const [id, entry] of projectIdCache) {
        if (!entry || now - entry.fetchedAt >= CACHE_TTL_MS) {
            projectIdCache.delete(id);
        }
    }

    for (const [id, f] of projectIdFailures) {
        if (!f || now - f.failedAt >= FAILURE_COOLDOWN_MS) {
            projectIdFailures.delete(id);
        }
    }

    for (const [id, item] of pendingFetches) {
        if (!item || typeof item.startedAt !== "number") {
            pendingFetches.delete(id);
            continue;
        }
        if (now - item.startedAt > PENDING_TTL_MS) {
            try { item.controller.abort(); } catch (_) { /* ignore */ }
            pendingFetches.delete(id);
        }
    }
}

/** Start the periodic background cleanup (idempotent). Called automatically on module load. */
export function startCacheCleanup() {
    if (_cleanupTimer) return;
    _cleanupTimer = setInterval(() => {
        try { cleanupNow(); } catch (e) {
            console.warn("[ProjectId] cleanup sweep error:", e?.message ?? e);
        }
    }, CLEANUP_INTERVAL_MS);
    // Unref so the timer doesn't prevent Node from exiting when it is otherwise idle
    _cleanupTimer?.unref?.();
}

/** Stop the periodic background cleanup (e.g. during graceful shutdown). */
export function stopCacheCleanup() {
    if (!_cleanupTimer) return;
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
}

// Start automatically when the module is first imported
startCacheCleanup();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the Project ID for a connection, with caching.
 * Returns null on failure (callers should fall back to random generation).
 *
 * @param {string} connectionId - The connection identifier for cache keying
 * @param {string} accessToken  - Valid OAuth access token
 * @param {string} [provider="gemini-cli"] - Provider id; selects the right
 *   Cloud Code Assist endpoints (gemini-cli uses cloudcode-pa, antigravity
 *   uses daily-cloudcode-pa). See CLOUD_CODE_API in appConstants.js.
 * @returns {Promise<string|null>} Real project ID or null
 */
export async function getProjectIdForConnection(connectionId, accessToken, provider = "gemini-cli") {
    if (!connectionId || !accessToken) return null;

    // Return cached value if still fresh
    const cached = projectIdCache.get(connectionId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.projectId;
    }

    // Negative cache: a recent failed fetch is not re-attempted within the
    // cooldown window. Prevents the hot path from burning the full 5-attempt
    // onboardUser on every request after a token refresh when Google's backend
    // won't provision a project for this account.
    const fail = projectIdFailures.get(connectionId);
    if (fail && Date.now() - fail.failedAt < FAILURE_COOLDOWN_MS) {
        return null;
    }

    // Deduplicate concurrent fetches for the same connection
    if (pendingFetches.has(connectionId)) {
        return pendingFetches.get(connectionId).promise;
    }

    // Each fetch gets its own AbortController so it can be canceled via removeConnection()
    const controller = new AbortController();

    const promise = (async () => {
        try {
            const projectId = await fetchProjectId(accessToken, controller.signal, provider);
            if (projectId) {
                projectIdCache.set(connectionId, {projectId, fetchedAt: Date.now()});
                projectIdFailures.delete(connectionId);
                return projectId;
            }
            console.warn("[ProjectId] could not fetch projectId for connection", connectionId.slice(0, 8));
            projectIdFailures.set(connectionId, { failedAt: Date.now() });
            return null;
        } catch (error) {
            console.warn(`[ProjectId] Error fetching project ID: ${error.message}`);
            // Network/backend errors also back off — don't hammer a down host.
            projectIdFailures.set(connectionId, { failedAt: Date.now() });
            return null;
        } finally {
            pendingFetches.delete(connectionId);
        }
    })();

    pendingFetches.set(connectionId, {promise, controller, startedAt: Date.now()});
    return promise;
}

/**
 * Invalidate the cached project ID for a connection.
 * Call this when a connection's credentials are fully revoked or refreshed.
 */
export function invalidateProjectId(connectionId) {
    projectIdCache.delete(connectionId);
    projectIdFailures.delete(connectionId);
}

/**
 * Fully remove a connection: abort any in-flight fetch and delete its cached project ID.
 * Wire this into your connection close / disconnect lifecycle events to prevent memory leaks.
 *
 * @param {string} connectionId
 */
export function removeConnection(connectionId) {
    if (!connectionId) return;
    projectIdCache.delete(connectionId);
    projectIdFailures.delete(connectionId);
    const pending = pendingFetches.get(connectionId);
    if (pending) {
        try { pending.controller.abort(); } catch (_) { /* ignore */ }
        pendingFetches.delete(connectionId);
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetch project ID via loadCodeAssist endpoint.
 * Falls back to onboardUser when loadCodeAssist returns no project.
 *
 * @param {string}      accessToken
 * @param {AbortSignal} signal
 * @returns {Promise<string|null>}
 */
async function fetchProjectId(accessToken, signal, provider) {
    const endpoints = CLOUD_CODE_API[provider] || CLOUD_CODE_API["gemini-cli"];
    const headers = provider === "antigravity" ? ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS : LOAD_CODE_ASSIST_HEADERS;
    const response = await fetch(endpoints.loadCodeAssist, {
        method: "POST",
        headers: { ...headers, "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
        signal
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`loadCodeAssist failed: HTTP ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const projectId = extractProjectId(data);
    if (projectId) return projectId;

    // loadCodeAssist returned no project — onboardUser is what provisions one
    // for a fresh account. This used to be skipped for the "daily-" canary
    // endpoints under the assumption that "the executor generates project IDs
    // locally", but that generated id is NOT a provisioned Google project:
    // every stored antigravity connection had projectId="" and the fake id was
    // what went out on the wire (DB-verified 2026-09-20). Attempt onboardUser
    // for every provider; if Google still won't provision we return null and
    // the caller keeps its fallback — no worse than skipping, and now the
    // happy path can actually persist a real id.
    //
    // Anti-abuse: onboardUser itself is bounded (MAX_ATTEMPTS=2, 12s+jitter)
    // and getProjectIdForConnection() negative-caches failures, so removing
    // the skip does not reintroduce a per-request retry storm.

    // Determine the tier to use for onboarding
    let tierID = "legacy-tier";
    if (Array.isArray(data.allowedTiers)) {
        for (const tier of data.allowedTiers) {
            if (tier && typeof tier === "object" && tier.isDefault === true) {
                if (tier.id && typeof tier.id === "string" && tier.id.trim()) {
                    tierID = tier.id.trim();
                    break;
                }
            }
        }
    }

    return onboardUser(accessToken, tierID, signal, endpoints, provider);
}

/**
 * Fetch project ID via onboardUser endpoint (polls until done).
 *
 * @param {string}      accessToken
 * @param {string}      tierID
 * @param {AbortSignal} externalSignal  – propagated from the connection's AbortController
 * @param {{loadCodeAssist: string, onboardUser: string}} endpoints - Cloud Code endpoints for this provider
 * @returns {Promise<string|null>}
 */
async function onboardUser(accessToken, tierID, externalSignal, endpoints, provider) {
    console.log(`[ProjectId] Onboarding user with tier: ${tierID}`);

    const reqBody = { tierId: tierID, metadata: LOAD_CODE_ASSIST_METADATA };
    const headers = provider === "antigravity" ? ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS : LOAD_CODE_ASSIST_HEADERS;
    // Google's anti-abuse heuristics flag tight onboarding retry bursts from
    // one IP — cap attempts low and space retries well apart with jitter
    // (both env-tunable for air-gapped/test setups).
    const MAX_ATTEMPTS = Number(process.env.ONBOARD_MAX_ATTEMPTS) || 2;
    const BASE_RETRY_DELAY_MS = Number(process.env.ONBOARD_RETRY_DELAY_MS) || 12_000;
    const jitter = () => Math.floor(Math.random() * 5000);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Bail out immediately if the connection was removed
        if (externalSignal?.aborted) return null;

        // Per-attempt timeout controller; forwards external abort as well
        const localCtrl = new AbortController();
        const timeoutId = setTimeout(() => localCtrl.abort(), 30_000);
        const forwardAbort = () => localCtrl.abort();
        externalSignal?.addEventListener("abort", forwardAbort);

        try {
            const response = await fetch(endpoints.onboardUser, {
                method: "POST",
                headers: { ...headers, "Authorization": `Bearer ${accessToken}` },
                body: JSON.stringify(reqBody),
                signal: localCtrl.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`onboardUser HTTP ${response.status}: ${errorText.slice(0, 200)}`);
            }

            const data = await response.json();

            if (data.done === true) {
                const projectId = extractProjectIdFromOnboard(data);
                if (projectId) {
                    console.log(`[ProjectId] Successfully onboarded, project ID: ${projectId}`);
                    return projectId;
                }
                // done:true is TERMINAL for Google's LRO — the response body
                // IS the final result. An empty cloudaicompanionProject means
                // the backend has decided not to provision one (header
                // fingerprinting / account state); polling again returns the
                // identical body, so retrying would burn ~2s×4 per connection
                // for nothing. Log the raw body once (diagnosable) and fail
                // fast — the negative cache (10 min) keeps the hot path from
                // re-attempting.
                console.warn(`[ProjectId] onboardUser returned done:true without a recognizable project_id — raw response: ${JSON.stringify(data).slice(0, 4000)}`);
                return null;
            }

            // Server not done yet – wait and retry with jitter
            console.log(`[ProjectId] Onboard attempt ${attempt}/${MAX_ATTEMPTS}: not done yet, waiting...`);
            await new Promise(resolve => setTimeout(resolve, BASE_RETRY_DELAY_MS + jitter()));

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === "AbortError") {
                console.warn(`[ProjectId] onboardUser attempt ${attempt} aborted (timeout or connection removed)`);
                if (externalSignal?.aborted) return null;   // connection gone – stop retrying
                continue;
            }
            if (attempt === MAX_ATTEMPTS) {
                console.warn(`[ProjectId] onboardUser failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
                return null;
            }
            // Continue to next attempt instead of throwing (which would skip remaining retries)
            console.warn(`[ProjectId] onboardUser attempt ${attempt} failed: ${error.message}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, BASE_RETRY_DELAY_MS + jitter()));
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", forwardAbort);
        }
    }

    return null;
}

/**
 * Extract project ID from loadCodeAssist response.
 */
function extractProjectId(data) {
    if (!data) return null;

    if (typeof data.cloudaicompanionProject === "string") {
        const id = data.cloudaicompanionProject.trim();
        if (id) return id;
    }

    if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
        const id = data.cloudaicompanionProject.id;
        if (typeof id === "string" && id.trim()) return id.trim();
    }

    return null;
}

/**
 * Extract a project id from a scalar that may be a plain string, an object
 * with an id-ish field, or a Google-style resource name ("projects/<id>").
 */
function projectIdFromScalar(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.startsWith("projects/") ? trimmed.slice("projects/".length) : trimmed;
    }
    if (value && typeof value === "object") {
        for (const key of ["id", "projectId", "project_id"]) {
            if (typeof value[key] === "string" && value[key].trim()) {
                return value[key].trim();
            }
        }
    }
    return null;
}

/**
 * Extract project ID from onboardUser response.
 *
 * Google's backend has returned the project in several shapes over time, so a
 * single hard-coded path (response.cloudaicompanionProject) turns API contract
 * drift into "onboardUser done but no project_id" failures for every account
 * at once. Walk the common candidate paths in priority order instead:
 *
 *   { done: true, response: { cloudaicompanionProject: "id" | { id } } }  ← historical
 *   { done: true, cloudaicompanionProject: "id" | { id } }                ← flat variant
 *   { done: true, response: { project: "id" | { id } } }
 *   { done: true, response: { project_id: "id" } }
 *   { done: true, projectId: "id" }
 *   { done: true, project_id: "id" }
 *   { done: true, response: { id } }                                      ← last resort
 */
function extractProjectIdFromOnboard(data) {
    if (!data || typeof data !== "object") return null;

    const paths = [
        "response.cloudaicompanionProject",
        "cloudaicompanionProject",
        "response.project",
        "project",
        "response.projectId",
        "projectId",
        "project_id",
        "response.project_id",
        "response.id",
        "id",
    ];

    for (const path of paths) {
        const value = path.split(".").reduce(
            (acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined),
            data
        );
        const id = projectIdFromScalar(value);
        if (id) return id;
    }
    return null;
}

// ─── Test-only hooks ─────────────────────────────────────────────────────────
// Seed a negative-cache entry directly (bypasses the slow fetch → onboardUser
// path that sleeps 2s × 5 attempts) so unit tests can exercise the negative
// cache deterministically without waiting on real timers or mocking setTimeout.
export function _seedProjectIdFailure(connectionId, failedAt = Date.now()) {
    projectIdFailures.set(connectionId, { failedAt });
}

export function _resetProjectIdState() {
    projectIdCache.clear();
    projectIdFailures.clear();
    pendingFetches.clear();
}
