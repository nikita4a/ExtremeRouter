// Verify that a conol-web row imported into the ER database resolves to a valid
// Cookie header through the real production code path (open-sse/services/conolAuth.js).
// Usage: node scripts/check-conol-cred.mjs [path-to-cred.json]
import fs from "node:fs";
import { resolveConolCredentials, normalizeConolCookie } from "../open-sse/services/conolAuth.js";

const credPath = process.argv[2] || "C:/Users/User/tmp/er_cred.json";
const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
const creds = {
  providerSpecificData: raw.data.providerSpecificData,
  apiKey: raw.data.apiKey,
};
const { cookie } = resolveConolCredentials(creds);
const ok = cookie.startsWith("__Secure-better-auth.session_token=");

console.log("account:", raw.name, "| resolved ok:", ok, "| header length:", cookie.length);
console.log("prefix:", cookie.slice(0, 46) + "...");
console.log("bare-token normalize:", normalizeConolCookie("abc123"));
if (!ok) {
  console.error("FAIL: ER would send a malformed Cookie header");
  process.exit(1);
}
console.log("PASS: ER conolAuth turns the imported DB row into a valid Cookie header");
