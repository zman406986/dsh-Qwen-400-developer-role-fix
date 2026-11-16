/**
 * dsh-qwen-400-developer-role-fix
 *
 * DSH profile plugin that stops the pi-ai adapter from sending OpenAI's
 * "developer" role to Qwen / DashScope compatible endpoints.
 *
 * Why
 * ---
 * pi-ai chooses the instruction role while building a request:
 *
 *   const role = model.reasoning && compat.supportsDeveloperRole
 *     ? "developer"
 *     : "system";
 *
 * `supportsDeveloperRole` is auto-detected from the provider id and base URL.
 * A custom Qwen route is not in pi-ai's non-standard-provider list, so the
 * detection returns true. A reasoning-enabled Qwen model then receives
 * `role: "developer"`, which DashScope rejects with:
 *
 *   400 invalid_parameter_error
 *   developer is not one of ['system', 'assistant', 'user', 'tool', 'function']
 *
 * Scope
 * -----
 * It only acts on reasoning-capable routes whose model id contains a Qwen /
 * DashScope marker. Provider names and base URLs are deliberately not used:
 * one provider or gateway can serve several model families. An explicit
 * `models` filter replaces auto-detection, so an opaque Qwen route can still
 * be targeted by its exact model id.
 *
 * What
 * ----
 * On a matching `llm/stream`, this plugin finds the live pi-ai model descriptor
 * and sets `compat.supportsDeveloperRole = false`. It creates the `compat`
 * object when the route has none — the case the older community plugin misses.
 * pi-ai reads the descriptor inside `stream()`, so the current request switches
 * to `role: "system"` while `model.reasoning` stays true and the
 * reasoning-effort menu / `reasoning_effort` parameter keep working.
 *
 * It never rewrites the `llm/stream` options object: agent-loop requests are
 * deep-frozen, and auxiliary calls (compaction, session title) need their
 * message prefix byte-identical for cache reuse.
 *
 * If DSH internals that expose the descriptor change, the plugin logs and
 * fails open — the request proceeds unchanged. It never blocks a request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "qwen-developer-role-fix";

/** Cordis service this plugin requires; also declared on the bundle patch row. */
export const inject = ["llm"];

/** Markers that identify Qwen / DashScope / Tongyi model ids. */
const QWEN_ROUTE_MARKERS = [
  "qwen",
  "dashscope",
  "bailian",
  "aliyun",
  "qianwen",
  "tongyi",
  "qwq",
  "qvq",
];

/** Normalize a config list. A comma-separated string is accepted for convenience. */
function stringList(value) {
  if (typeof value === "string") value = value.split(",");
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Resolve plugin config with documented defaults. */
function normalizeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  return {
    models: stringList(config.models),
    logPath: typeof config.logPath === "string" ? config.logPath.trim() : "",
    debug: config.debug === true,
  };
}

/** Expand a leading ~ so a profile can log under the user's home directory. */
function expandHome(filePath) {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/** Optional JSONL probe log; a no-op unless logPath or debug is set. */
function createLog(config, ctx) {
  if (!config.logPath && !config.debug) return () => {};
  const logPath = config.logPath ? expandHome(config.logPath) : "";
  return (entry) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    if (logPath) {
      try {
        fs.appendFileSync(logPath, `${line}\n`);
      } catch {
        /* logging must never break a request */
      }
    }
    if (config.debug) {
      try {
        ctx.logger?.info?.(`[qwen-developer-role-fix] ${line}`);
      } catch {
        /* ignore */
      }
    }
  };
}

/** Find the adapter that owns a provider, across known DSH registry shapes. */
function adapterFor(llm, provider) {
  if (!llm) return undefined;
  if (typeof llm.getAdapter === "function") {
    try {
      const found = llm.getAdapter(provider);
      if (found) return found.adapter ?? found;
    } catch {
      /* fall through to the registry */
    }
  }
  const registry = llm.adapters ?? llm.registry ?? llm._adapters;
  if (!registry) return undefined;
  let entry;
  if (typeof registry.get === "function") entry = registry.get(provider);
  else if (typeof registry === "object") entry = registry[provider];
  if (!entry) return undefined;
  return entry.adapter ?? entry;
}

/** Read the exact model descriptor pi-ai will use for this request. */
function modelFor(adapter, provider, modelId) {
  if (!adapter) return undefined;
  let snapshot;
  try {
    snapshot = typeof adapter.current === "function" ? adapter.current() : undefined;
  } catch {
    snapshot = undefined;
  }
  const models = snapshot?.models ?? adapter.snapshot?.models ?? adapter.models;
  if (!models) return undefined;
  try {
    if (typeof models.getModel === "function") {
      const direct = models.getModel(provider, modelId);
      if (direct) return direct;
    }
    if (typeof models.getModels === "function") {
      return models.getModels(provider)?.find((model) => model?.id === modelId);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Whether the model id itself looks Qwen-related. */
function looksLikeQwen(modelId, model) {
  const haystack = [modelId, model?.id]
    .filter((value) => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return QWEN_ROUTE_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * One applicability pass. Returns { apply, reason, trigger }.
 * An explicit `models` list replaces model-id auto-detection; reasoning is
 * always required.
 */
function evaluateScope(config, modelId, model) {
  if (!model.reasoning) return { apply: false, reason: "not-reasoning" };

  if (config.models.length > 0) {
    return config.models.includes(modelId)
      ? { apply: true, trigger: "explicit" }
      : { apply: false, reason: "no-match" };
  }

  return looksLikeQwen(modelId, model)
    ? { apply: true, trigger: "qwen" }
    : { apply: false, reason: "not-qwen" };
}

/**
 * Flip the descriptor's developer-role switch, preserving every other compat
 * field and every other model capability (notably `reasoning`).
 */
function disableDeveloperRole(model) {
  if (!model || typeof model !== "object") return { flipped: false, reason: "no-model" };
  const previous = model.compat?.supportsDeveloperRole;
  if (previous === false) return { flipped: false, already: true };

  const current = model.compat;
  const compat =
    current && typeof current === "object" && !Array.isArray(current) ? current : null;

  if (compat && Object.isFrozen(compat)) {
    if (Object.isFrozen(model)) return { flipped: false, reason: "frozen" };
    model.compat = { ...compat, supportsDeveloperRole: false };
    return { flipped: true, previous };
  }

  const next = compat ?? {};
  next.supportsDeveloperRole = false;
  if (model.compat !== next) model.compat = next;
  return { flipped: true, previous };
}

/** Resolve the LLM service without requiring cordis injection at call time. */
function resolveLlm(ctx) {
  try {
    const viaGet = ctx.get?.("llm");
    if (viaGet) return viaGet;
  } catch {
    /* try the injected service next */
  }
  try {
    return ctx.llm;
  } catch {
    return undefined;
  }
}

/**
 * Install the waterfall listener.
 * @param ctx - cordis context carrying the `llm` service.
 * @param rawConfig - plugin config (models / logPath / debug).
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const log = createLog(config, ctx);

  ctx.on(
    "llm/stream",
    (options, next) => {
      const provider = options?.provider;
      const modelId = options?.model;
      if (typeof provider !== "string" || typeof modelId !== "string") return next();

      try {
        const llm = resolveLlm(ctx);
        const adapter = adapterFor(llm, provider);
        const model = modelFor(adapter, provider, modelId);

        if (!model) {
          log({
            event: "skip",
            reason: adapter ? "no-model" : "no-adapter",
            provider,
            model: modelId,
          });
          return next();
        }

        // One pass over the reasoning gate and model-id scope.
        const decision = evaluateScope(config, modelId, model);
        if (!decision.apply) {
          log({
            event: "skip",
            reason: decision.reason,
            provider,
            model: modelId,
            baseUrl: model.baseUrl,
          });
          return next();
        }

        const result = disableDeveloperRole(model);
        log({
          event: "stream",
          provider,
          model: modelId,
          baseUrl: model.baseUrl,
          trigger: decision.trigger,
          reasoning: model.reasoning,
          ...result,
        });
      } catch (error) {
        log({
          event: "error",
          provider,
          model: modelId,
          error: String(error?.stack ?? error),
        });
      }
      return next();
    },
    { global: true, prepend: true },
  );
}

export default apply;
