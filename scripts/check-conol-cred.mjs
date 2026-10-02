// Verify that an imported conol-web credential resolves to a valid Cookie header
// through the real production code path (open-sse/services/conolAuth.js).
//
// Usage: node scripts/check-conol-cred.mjs <cred.json>
//   cred.json = { "name": ..., "data": <the `data` JSON of a providerConnections row> }
import fs from "node:fs";
import { resolveConolCredentials, normalizeConolCookie } from "../open-sse/services/conolAuth.js";

const credPath = process.argv[2];
if (!credPath) {
  console.error("usage: node scripts/check-conol-cred.mjs <cred.json>");
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
const creds = {
  apiKey: raw.data.apiKey,
  providerSpecificData: raw.data.providerSpecificData,
};
const { cookie } = resolveConolCredentials(creds);
const ok = cookie.startsWith("__Secure-better-auth.session_token=") && cookie.length > 40;

console.log("account:", raw.name, "| resolved ok:", ok, "| header length:", cookie.length);
console.log("prefix:", cookie.slice(0, 46) + "...");
console.log("bare-token normalize:", normalizeConolCookie("abc123"));
if (!ok) {
  console.error("FAIL: ER would send a malformed or empty Cookie header");
  process.exit(1);
}
console.log("PASS: ER conolAuth turns the imported DB row into a valid Cookie header");
