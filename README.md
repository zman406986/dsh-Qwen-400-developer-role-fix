# dsh-qwen-400-developer-role-fix

A small DSH plugin that stops Qwen / DashScope OpenAI-compatible endpoints from rejecting requests with:

```text
400 invalid_parameter_error
developer is not one of ['system', 'assistant', 'user', 'tool', 'function']
```

DSH's pi-ai adapter sends the `developer` role when a model supports reasoning and pi-ai's `supportsDeveloperRole` flag is true. This plugin sets that flag to `false` for matching models. Reasoning stays enabled.

## Scope

A request is changed only when both are true:

1. `model.reasoning` is truthy.
2. The model id contains a Qwen marker: `qwen`, `dashscope`, `bailian`, `aliyun`, `qianwen`, `tongyi`, `qwq`, or `qvq` — or you explicitly list the exact id in `models`.

The plugin checks the model id only. Provider names and base URLs are not used for matching, because one provider or gateway can serve several model families.

With no `models` configured, these match:

- `qwen4-max-preview`
- `qwen/qwen3-max`
- `/models/Qwen/Qwen3.8-27B`

For an opaque model id, set `models: [your-model-id]`.

## Install

```sh
dsh plugin --profile multitask add github:zman406986/dsh-Qwen-400-developer-role-fix
```

Or install a local checkout:

```sh
dsh plugin --profile multitask add C:\path\to\dsh-Qwen-400-developer-role-fix
```

Restart DSH.

### Manual

Copy the folder into your profile's `plugins/` directory and add:

```yaml
- insert:
    - id: qwen-developer-role-fix
      name: ./plugins/dsh-Qwen-400-developer-role-fix/index.js
      inject: [llm]
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `models` | `[]` | Exact model ids. Empty = auto-detect from the model id. When set, replaces auto-detection. |
| `logPath` | `""` | Optional JSONL probe log. |
| `debug` | `false` | Also emit probe lines through the DSH logger. |

Override by row id:

```yaml
- id: qwen-developer-role-fix
  config:
    models: [my-opaque-qwen-model]
    logPath: "~/.dsh/qwen-role-fix.log"
```

## Verify

```sh
npm test
```

24 tests cover the reasoning gate, model-id detection, explicit `models`, frozen descriptors, and fail-open behavior.

With `logPath` set, a matching request writes a line containing `"trigger":"qwen"` and `"flipped":true`. A skip writes a `reason`: `not-qwen`, `not-reasoning`, or `no-match`.

## How it works

The plugin listens to `llm/stream`, resolves the live pi-ai model descriptor, and sets `compat.supportsDeveloperRole = false`. It does not modify the request options. If DSH internals change or the descriptor cannot be resolved, it fails open and calls the next listener.

## Compatibility

- Tested with DSH `0.2.2-rc.1` and pi-ai `1.5.0`.
- No `engines.dsh` gate.
- No runtime dependencies.

## License

MIT © 2026 zman406986
