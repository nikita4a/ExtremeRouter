// Runtime acceptance for the conol-web integration: run ER's OWN production
// discovery code against the real site, with a credential shaped exactly like the
// one the importer stores in providerConnections.data.
//
// This bypasses the Next.js server (and therefore requireLogin), and it is the
// strongest available proof short of a full chat completion: it exercises
// conolAuth.normalizeConolCookie + conolModels.discoverConolModels +
// parseConolAgentServers against https://conol.ai/api/agent-servers.
//
// Usage: node scripts/check-conol-discovery.mjs <cred.json>
//   cred.json = { "name": ..., "data": <the `data` JSON of a providerConnections row> }
import fs from "node:fs";
import { resolveConolCredentials } from "../open-sse/services/conolAuth.js";
import { discoverConolModels } from "../open-sse/services/conolModels.js";

const credPath = process.argv[2];
if (!credPath) {
  console.error("usage: node scripts/check-conol-discovery.mjs <cred.json>");
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
const { cookie } = resolveConolCredentials({
  apiKey: raw.data.apiKey,
  providerSpecificData: raw.data.providerSpecificData,
});
console.log("account:", raw.name, "| cookie header length:", cookie.length);

try {
  const discovered = await discoverConolModels({ cookie });
  const ids = (discovered.models || []).map((m) => m.id || m);
  console.log("discoverConolModels OK -> models:", ids.length);
  console.log("  first:", ids.slice(0, 10).join(", "));
  if (!ids.length) {
    console.error("FAIL: empty catalog");
    process.exit(1);
  }
  console.log("PASS: ER production code fetched a live conol model catalog with the imported credential");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
