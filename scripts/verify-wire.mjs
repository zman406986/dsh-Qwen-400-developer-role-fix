/**
 * Prove the fix at the pi-ai wire level, without a network call or API key.
 *
 * Usage:
 *   node scripts/verify-wire.mjs <path-to-openai-completions.js>
 *
 * The path is the pi-ai file shipped inside DSH:
 *   <dsh>/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
 *
 * It runs pi-ai's real OpenAI-completions stream() twice with a stubbed fetch:
 * once without a compat override (expects role "developer") and once with
 * supportsDeveloperRole: false (expects role "system").
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const requested = process.argv[2] ?? process.env.DSH_PI_AI_OPENAI_COMPLETIONS;
if (!requested) {
  console.error(
    "Usage: node scripts/verify-wire.mjs <path-to-openai-completions.js>\n" +
      "Or set DSH_PI_AI_OPENAI_COMPLETIONS to that path.",
  );
  process.exit(2);
}

const file = path.resolve(requested);
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}

const { stream } = await import(pathToFileURL(file).href);

const baseModel = {
  id: "qwen4-max-preview",
  name: "qwen4-max-preview",
  api: "openai-completions",
  provider: "qwen",
  baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  thinkingLevelMap: { off: null, low: "low", medium: "medium", xhigh: "xhigh" },
  contextWindow: 500000,
  maxTokens: 30000,
};

async function capture(compat) {
  let body;
  const fakeFetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const response = stream(
    { ...baseModel, ...(compat ? { compat } : {}) },
    {
      messages: [
        { role: "system", content: "You are helpful.", timestamp: Date.now() },
        { role: "user", content: "hi", timestamp: Date.now() },
      ],
    },
    { apiKey: "test", fetch: fakeFetch, reasoningEffort: "low" },
  );

  for await (const _event of response) {
    /* drain */
  }
  return body;
}

const withoutFix = await capture(undefined);
const withFix = await capture({ supportsDeveloperRole: false });
const withoutRole = withoutFix.messages[0].role;
const withRole = withFix.messages[0].role;

console.log(
  JSON.stringify(
    {
      wireRolesWithoutFix: withoutFix.messages.map((message) => message.role),
      wireRolesWithFix: withFix.messages.map((message) => message.role),
    },
    null,
    2,
  ),
);

if (withoutRole !== "developer" || withRole !== "system") {
  console.error(`FAIL: expected developer -> system, got ${withoutRole} -> ${withRole}`);
  process.exit(1);
}
console.log("PASS: supportsDeveloperRole=false turns the wire role from 'developer' into 'system'.");
