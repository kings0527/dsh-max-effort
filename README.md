# dsh-max-effort

A DeepSeek Harness (DSH) Host bundle: **every model switch lands on the
highest reasoning effort that model advertises**, so picking Max never costs a
second click. Requests that name no effort are lifted to the same level.

## 中文速览

- **作用**：在 DSH 里切换模型时，自动选中该模型支持的最高思考强度（有 `max` 就是 Max，否则取最高档），标签也会直接显示，不用再点第二次。
- **安装**：DSH 侧边栏 **Plugins** 里安装 bundle，填 `github:kings0527/dsh-max-effort`；或让 agent 用 `plugin_manager` 的 `install_bundle` 安装这个地址。
- **装完**：刷新 GUI 一次（Ctrl+R），再切模型即可看到最高档。
- 仓库是私有时，那台电脑需要先有可用的 GitHub 凭据。

## Install on another computer

### From GitHub (recommended)

Open the sidebar **Plugins** page and install the bundle with this spec:

```
github:kings0527/dsh-max-effort
```

The full git URL works too: `git+https://github.com/kings0527/dsh-max-effort.git`.
If the `plugin_manager` tool is available in a session, the same thing is:

> Install the bundle `github:kings0527/dsh-max-effort` with `plugin_manager install_bundle`.

For a private repository, that machine's git must already be authenticated to
GitHub (HTTPS credential or SSH). Public repositories need no extra setup.

### From a clone

```sh
git clone https://github.com/kings0527/dsh-max-effort.git
```

Then install that directory as a bundle (Plugins page or
`plugin_manager install_bundle` with the absolute path).

### After installing

Refresh the Web GUI once (Ctrl+R). The model catalog is cached by the open
page; the refresh makes it refetch the Host defaults. Afterwards, switching
models shows and stores the highest level.

The plugin appears as **Max Reasoning Default** / **思考强度默认最高**.

## Why

The composer model seat and the `/model` popup build a selection from the
clicked model's `reasoning.defaultEffort`. When that field is absent (the
pi-ai routes such as `zai-coding-cn` and `opencode-go` do not set one), the
selection carries no effort, the caption reads “Default”, and picking the
highest level costs a second click every time. DeepSeek advertises `high` as
its default, so Max takes the same extra click there.

## What it does

| Seam | Effect |
|---|---|
| `llm.resolveModelInfo()` | Advertises the highest advertised effort as the model's `reasoning.defaultEffort`, so the model catalog makes every switch carry it and the caption shows it. |
| `agent/request` waterfall | A frozen call configuration without an explicit `reasoningEffort` is given the highest advertised effort before `llm.prepareCall()` validates it. Explicit efforts are preserved. |

Models with no reasoning metadata, or whose only level is `off`, are left
unchanged. For a model whose top level is `high` rather than `max`, the highest
advertised level is what gets selected.

## Implementation note

`ctx.llm` is a traceable proxy whose reads wrap every method in a second proxy,
so the override and its guard use `Symbol.for('cordis.original')` to reach the
raw service. Writing through the proxy also lands on the raw instance, but the
explicit target keeps the guard meaningful. If a future DSH release removes
`llm.resolveModelInfo`, the plugin row fails at activation instead of silently
reverting to “Default”.

## Configuration

Both switches default to `true`; override them in the profile patch when
needed.

```yaml
- id: max-effort
  name: '@local/dsh-max-effort'
  config:
    catalogDefault: true
    requestFallback: true
```

`catalogDefault: false` keeps the shipped catalog defaults; `requestFallback:
false` stops lifting effort-free requests. Set both to `false` to park the
plugin without uninstalling it.

## Test

```sh
node test/highest-effort.mjs
```

No dependencies; plain Node ESM.

## Uninstall

Disable or remove the bundle on the Plugins page. Updating the plugin code
requires a DSH restart to drop the previous module generation; a profile
change alone reloads the bundle through HMR.

## License

MIT
