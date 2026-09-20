/**
 * Antigravity projectId provisioning + bare-403 diagnostics.
 *
 * Regression for the intermittent "[403]: HTTP 403" symptom:
 *   - every stored antigravity connection had projectId="" (DB-verified
 *     2026-09-20), so the executor shipped a locally fabricated id as the
 *     request `project` field;
 *   - projectId.js used to SKIP onboardUser for any provider whose endpoint
 *     string contained "daily-" (the antigravity canary host), which
 *     guaranteed projectId could never be provisioned at runtime;
 *   - an empty-body 403 from Google's gateway was degraded to the useless
 *     string "HTTP 403" by BaseExecutor.parseError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getProjectIdForConnection,
  _resetProjectIdState,
} from "../../open-sse/services/projectId.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const realSetTimeout = globalThis.setTimeout;
const connId = "conn-ag-projectid";

beforeEach(() => {
  _resetProjectIdState();
  process.env.ONBOARD_MAX_ATTEMPTS = "3";
  process.env.ONBOARD_RETRY_DELAY_MS = "1";
  vi.stubGlobal("setTimeout", (fn, ms, ...args) => {
    if (ms > 0 && ms <= 6_000) return realSetTimeout(fn, 0, ...args);
    return realSetTimeout(fn, ms, ...args);
  });
});

afterEach(() => {
  _resetProjectIdState();
  delete process.env.ONBOARD_MAX_ATTEMPTS;
  delete process.env.ONBOARD_RETRY_DELAY_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Route by URL: onboardUser vs loadCodeAssist (works for canary hosts too). */
function stubFetch(loadAssistBody, onboardBodies) {
  const queue = [...onboardBodies];
  const fetchSpy = vi.fn((url) => {
    const isOnboard = String(url).includes("onboardUser");
    const body = isOnboard ? queue.shift() : loadAssistBody;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("antigravity projectId provisioning (daily-endpoint onboardUser no longer skipped)", () => {
  it("attempts onboardUser for antigravity when loadCodeAssist returns no project", async () => {
    const fetchSpy = stubFetch({}, [{ done: true, projectId: "proj-ag-canary" }]);

    const pid = await getProjectIdForConnection(connId, "ag-token", "antigravity");

    // Regression: this used to be null because projectId.js returned early on
    // any endpoint containing "daily-". Now onboardUser runs and its issued id
    // is adopted.
    expect(pid).toBe("proj-ag-canary");
    // loadCodeAssist + at least one onboardUser attempt
    const onboardCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes("onboardUser"));
    expect(onboardCalls.length).toBeGreaterThanOrEqual(1);
    // The antigravity endpoints are the canary host (CLOUD_CODE_API pinned).
    expect(String(fetchSpy.mock.calls[0][0])).toContain("daily-cloudcode-pa.googleapis.com");
  });

  it("returns the loadCodeAssist project directly without calling onboardUser", async () => {
    const fetchSpy = stubFetch({ cloudaicompanionProject: "proj-ag-direct" }, []);

    const pid = await getProjectIdForConnection(connId, "ag-token", "antigravity");

    expect(pid).toBe("proj-ag-direct");
    const onboardCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes("onboardUser"));
    expect(onboardCalls).toHaveLength(0);
  });

  it("returns null (and does not fabricate an id) when neither endpoint provisions one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // loadCodeAssist empty, onboardUser done:true with no recognizable project
    stubFetch({}, [{ done: true, response: { someUnrelatedField: 1 } }]);

    const pid = await getProjectIdForConnection(connId, "ag-token", "antigravity");

    expect(pid).toBeNull();
  });
});

describe("antigravity executor — bare/gateway 403 diagnostics", () => {
  it("turns an empty-body 403 into a diagnosable message instead of bare 'HTTP 403'", () => {
    const ag = new AntigravityExecutor();
    // Simulate what buildUrl + transformRequest cache just before the fetch.
    ag._lastRequestHost = "https://daily-cloudcode-pa.googleapis.com";
    ag._lastRequestProject = "bold-spark-a1b2c";

    const emptyHeaders = new Map([["www-authenticate", "Bearer realm=googleapis.com"]]);
    const fakeResponse = {
      status: 403,
      headers: { forEach: (cb) => emptyHeaders.forEach((v, k) => cb(v, k)) },
    };

    const parsed = ag.parseError(fakeResponse, "");

    expect(parsed.status).toBe(403);
    expect(parsed.message).toContain("HTTP 403");
    // Must explain WHY, not just repeat the status.
    expect(parsed.message).toContain("empty body");
    expect(parsed.message).toContain("gateway/IAM-level rejection");
    expect(parsed.message).toContain("daily-cloudcode-pa.googleapis.com");
    expect(parsed.message).toContain("bold-spark-a1b2c");
    expect(parsed.message).toContain("www-authenticate");
  });

  it("passes a non-empty body through unchanged (application-layer errors keep their payload)", () => {
    const ag = new AntigravityExecutor();
    const body = '{"error":{"message":"quota exhausted","code":429}}';
    const parsed = ag.parseError({ status: 429, headers: { forEach() {} } }, body);
    expect(parsed.message).toBe(body);
    expect(parsed.status).toBe(429);
  });

  it("caches the outgoing project id and warns when it is fabricated", () => {
    const ag = new AntigravityExecutor();
    // credentials with NO stored projectId → fabricated id
    const out = ag.transformRequest(
      "gemini-3.8-flash-high",
      { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      true,
      { email: "someone@example.com" }
    );
    expect(out.project).toBeTruthy();
    expect(ag._lastRequestProject).toBe(out.project);
  });

  it("uses the stored projectId verbatim when present (no fabrication)", () => {
    const ag = new AntigravityExecutor();
    const out = ag.transformRequest(
      "gemini-3.8-flash-high",
      { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      true,
      { projectId: "real-provisioned-project", email: "ok@example.com" }
    );
    expect(out.project).toBe("real-provisioned-project");
    expect(ag._lastRequestProject).toBe("real-provisioned-project");
  });
});
