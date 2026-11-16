import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, name } from "../index.js";

const QWEN_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";
const PROVIDER = "qwen";
const MODEL = "qwen4-max-preview";

function makeHarness({
  provider = PROVIDER,
  modelId = MODEL,
  model: modelOverrides = {},
  config = {},
  wrapAdapter = true,
  modelLookup = "getModel",
  provideLlmGetter = true,
  freezeModel = false,
} = {}) {
  const model = {
    id: modelId,
    provider,
    baseUrl: QWEN_URL,
    reasoning: true,
    ...modelOverrides,
  };
  if (freezeModel) Object.freeze(model);

  const models =
    modelLookup === "getModels"
      ? { getModels: (p) => (p === provider ? [model] : []) }
      : {
          getModel: (p, m) => (p === provider && m === modelId ? model : undefined),
          getModels: (p) => (p === provider ? [model] : []),
        };

  const adapter = { current: () => ({ models }) };
  const llm = {
    adapters: new Map([[provider, wrapAdapter ? { adapter } : adapter]]),
  };
  const handlers = new Map();
  const ctx = {
    on(event, handler, options) {
      handlers.set(event, { handler, options });
    },
    get(service) {
      return provideLlmGetter && service === "llm" ? llm : undefined;
    },
    logger: { info() {} },
  };
  if (!provideLlmGetter) ctx.llm = llm;

  apply(ctx, config);
  const entry = handlers.get("llm/stream");
  assert.ok(entry, "llm/stream handler is registered");
  return { model, handler: entry.handler, entry, ctx, llm, adapter };
}

function invoke(handler, options = { provider: PROVIDER, model: MODEL }) {
  const sentinel = { next: true };
  let calls = 0;
  const result = handler(options, () => {
    calls += 1;
    return sentinel;
  });
  return { calls, result, sentinel };
}

function wireRole(model) {
  // pi-ai auto-detects true for this Qwen URL when no compat override exists.
  const supportsDeveloperRole = model.compat?.supportsDeveloperRole ?? true;
  return model.reasoning && supportsDeveloperRole ? "developer" : "system";
}

function tempLogPath() {
  return path.join(
    os.tmpdir(),
    `dsh-qwen-rolefix-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
  );
}

function lastLogEntry(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1));
}

test("exports the expected plugin name", () => {
  assert.equal(name, "qwen-developer-role-fix");
});

test("registers one global, prepended llm/stream listener", () => {
  const { entry } = makeHarness();
  assert.deepEqual(entry.options, { global: true, prepend: true });
});

test("creates compat when the descriptor has none and switches the wire role to system", () => {
  const { model, handler } = makeHarness();
  assert.equal(model.compat, undefined);

  const { calls, result, sentinel } = invoke(handler);
  assert.equal(calls, 1);
  assert.equal(result, sentinel);
  assert.deepEqual(model.compat, { supportsDeveloperRole: false });
  assert.equal(model.reasoning, true);
  assert.equal(wireRole(model), "system");
});

test("preserves every other compat switch", () => {
  const { model, handler } = makeHarness({
    model: {
      compat: {
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "qwen",
      },
    },
  });

  invoke(handler);

  assert.deepEqual(model.compat, {
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
    thinkingFormat: "qwen",
    supportsDeveloperRole: false,
  });
  assert.equal(model.reasoning, true);
});

test("is idempotent across repeated requests", () => {
  const { model, handler } = makeHarness({ model: { compat: { supportsDeveloperRole: false } } });
  const first = model.compat;

  invoke(handler);
  invoke(handler);

  assert.equal(model.compat, first);
  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("leaves a non-Qwen reasoning route alone by default", () => {
  const provider = "deepseek-official";
  const modelId = "deepseek-reasoner";
  const { model, handler } = makeHarness({
    provider,
    modelId,
    model: { baseUrl: "https://api.deepseek.com" },
  });

  invoke(handler, { provider, model: modelId });

  assert.equal(model.compat, undefined);
  assert.equal(wireRole(model), "developer");
});

test("detects Qwen from the model id even when provider and base URL are generic", () => {
  const provider = "my-gateway";
  const modelId = "qwen4-max-preview";
  const { model, handler } = makeHarness({
    provider,
    modelId,
    model: { baseUrl: "https://proxy.example/v1" },
  });

  invoke(handler, { provider, model: modelId });

  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("uses only the model id, not the provider name or base URL", () => {
  const routes = [
    { provider: "qwen", modelId: "m1", baseUrl: "https://proxy.example/v1" },
    { provider: "my-gateway", modelId: "m1", baseUrl: QWEN_URL },
  ];

  for (const route of routes) {
    const { model, handler } = makeHarness({
      provider: route.provider,
      modelId: route.modelId,
      model: { baseUrl: route.baseUrl },
    });

    invoke(handler, { provider: route.provider, model: route.modelId });

    assert.equal(model.compat, undefined, `${route.provider} ${route.baseUrl}`);
  }
});

test("detects QwQ and QvQ model families", () => {
  for (const modelId of ["qwq-32b", "qvq-max"]) {
    const provider = "my-gateway";
    const { model, handler } = makeHarness({
      provider,
      modelId,
      model: { baseUrl: "https://proxy.example/v1" },
    });

    invoke(handler, { provider, model: modelId });

    assert.equal(model.compat?.supportsDeveloperRole, false, modelId);
  }
});

test("skips a non-reasoning Qwen route", () => {
  const { model, handler } = makeHarness({ model: { reasoning: false } });

  invoke(handler);

  assert.equal(model.compat, undefined);
  assert.equal(wireRole(model), "system");
});

test("leaves a model outside the explicit allow-list alone", () => {
  const { model, handler } = makeHarness({
    config: { models: ["another-model"] },
  });

  invoke(handler);

  assert.equal(model.compat, undefined);
});

test("ignores baseUrlPatterns because base URL is no longer a scope input", () => {
  const provider = "my-gateway";
  const modelId = "m1";
  const { model, handler } = makeHarness({
    provider,
    modelId,
    model: { baseUrl: QWEN_URL },
    config: { baseUrlPatterns: [QWEN_URL] },
  });

  invoke(handler, { provider, model: modelId });

  assert.equal(model.compat, undefined);
});

test("uses an explicit model filter to target an opaque route", () => {
  const provider = "my-gateway";
  const modelId = "m1";
  const { model, handler } = makeHarness({
    provider,
    modelId,
    model: { baseUrl: "https://proxy.example/v1" },
    config: { models: [modelId] },
  });

  invoke(handler, { provider, model: modelId });

  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("an explicit model filter still requires reasoning", () => {
  const { model, handler } = makeHarness({
    model: { reasoning: false },
    config: { models: [MODEL] },
  });

  invoke(handler);

  assert.equal(model.compat, undefined);
});

test("does not mutate or replace the frozen llm/stream options", () => {
  const { handler } = makeHarness();
  const options = Object.freeze({
    provider: PROVIDER,
    model: MODEL,
    messages: Object.freeze([{ role: "user", content: "hi", timestamp: 1 }]),
  });

  assert.doesNotThrow(() => invoke(handler, options));
  assert.deepEqual(options, {
    provider: PROVIDER,
    model: MODEL,
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  });
});

test("accepts a registry that stores the adapter directly", () => {
  const { model, handler } = makeHarness({ wrapAdapter: false });

  invoke(handler);

  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("falls back to ctx.llm when ctx.get is unavailable", () => {
  const { model, handler } = makeHarness({ provideLlmGetter: false });

  invoke(handler);

  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("supports a models collection that only exposes getModels", () => {
  const { model, handler } = makeHarness({ modelLookup: "getModels" });

  invoke(handler);

  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("fails open when no adapter owns the provider", () => {
  const handlers = new Map();
  const ctx = {
    on(event, handler, options) {
      handlers.set(event, { handler, options });
    },
    get: () => ({ adapters: new Map() }),
    logger: { info() {} },
  };
  apply(ctx, {});

  const { calls, result } = invoke(handlers.get("llm/stream").handler);
  assert.equal(calls, 1);
  assert.deepEqual(result, { next: true });
});

test("replaces a frozen compat object instead of mutating it", () => {
  const frozen = Object.freeze({ supportsReasoningEffort: true });
  const { model, handler } = makeHarness({ model: { compat: frozen } });

  invoke(handler);

  assert.notEqual(model.compat, frozen);
  assert.equal(model.compat.supportsReasoningEffort, true);
  assert.equal(model.compat.supportsDeveloperRole, false);
});

test("fails open when the model descriptor itself is frozen", () => {
  const { model, handler } = makeHarness({ freezeModel: true });

  assert.doesNotThrow(() => invoke(handler));
  assert.equal(model.compat, undefined);
  assert.equal(wireRole(model), "developer");
});

test("writes a JSONL probe line for a Qwen match", () => {
  const logPath = tempLogPath();
  try {
    const { handler } = makeHarness({ config: { logPath } });

    invoke(handler);

    const entry = lastLogEntry(logPath);
    assert.equal(entry.event, "stream");
    assert.equal(entry.provider, PROVIDER);
    assert.equal(entry.model, MODEL);
    assert.equal(entry.flipped, true);
    assert.equal(entry.baseUrl, QWEN_URL);
    assert.equal(entry.trigger, "qwen");
    assert.equal(entry.reasoning, true);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test("logs why a non-Qwen route is skipped", () => {
  const logPath = tempLogPath();
  const provider = "deepseek-official";
  const modelId = "deepseek-reasoner";
  try {
    const { handler } = makeHarness({
      provider,
      modelId,
      model: { baseUrl: "https://api.deepseek.com" },
      config: { logPath },
    });

    invoke(handler, { provider, model: modelId });

    const entry = lastLogEntry(logPath);
    assert.equal(entry.event, "skip");
    assert.equal(entry.reason, "not-qwen");
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test("logs why a non-reasoning route is skipped", () => {
  const logPath = tempLogPath();
  try {
    const { handler } = makeHarness({
      model: { reasoning: false },
      config: { logPath },
    });

    invoke(handler);

    const entry = lastLogEntry(logPath);
    assert.equal(entry.event, "skip");
    assert.equal(entry.reason, "not-reasoning");
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
