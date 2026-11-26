# dsh-max-effort

A DeepSeek Harness (DSH) Host bundle: **every model switch lands on the
highest reasoning effort that model advertises**, so picking Max never costs a
second click.

DSH 0.2.2 freezes a step's model selection before `agent/request`. This plugin
therefore sets the default at model-selection time and **never rewrites a
frozen request**; a late override is rejected by the runtime with
`use agent.model.select() before step preparation`.

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

The plugin announces `llm/adapters-updated` after it patches the catalog, and
the client refreshes its model catalog on that notification. A page that was
already connected — including one that connected while DSH was still starting —
picks up the new defaults without a reload. Refresh once (Ctrl+R) only as a
fallback. Afterwards, switching models shows and stores the highest level.

The plugin appears as **Max Reasoning Default** / **思考强度默认最高**.

## Why

The composer model seat and the `/model` popup build a selection from the
clicked model's `reasoning.defaultEffort`. When that field is absent (the
pi-ai routes such as `zai-coding-cn` and `opencode-go` do not set one), the
selection carries no effort, the caption reads “Default”, and picking the
highest level costs a second click every time. DeepSeek advertises `high` as
its default, so Max takes the same extra click there.

The client fetches that catalog once per connection and caches it until a
registry notification arrives, so a page connected before the patch keeps the
pre-patch defaults; announcing the update is what closes that window.

## What it does

| Seam | Effect |
|---|---|
| `llm.resolveModelInfoFor()` | The one resolution point behind both the public model catalog and `resolveCallConfig`, which `session.selectModel` uses to normalize and store a selection. Raising `reasoning.defaultEffort` there makes every model switch store the highest effort **even when the client sends none** — the caption reads the stored selection, so a stale client-side catalog cannot reintroduce “Default”. |
| `llm.prepareCall()` | Passes a `ConfigureCall` that gives a call without an explicit `reasoningEffort` the highest advertised effort. It runs after step preparation fixed the selection and before defaults/validation, so the logged header and the provider request both carry the level. Explicit efforts are preserved. |
| `llm/adapters-updated` | Tells connected clients to refetch the catalog after the patch, including a delayed repeat for a client that connects while the composition starts. |

Models with no reasoning metadata, or whose only level is `off`, are left
unchanged. For a model whose top level is `high` rather than `max`, the highest
advertised level is what gets selected.

A Session resumed from a log whose stored selection predates this plugin still
carries no effort, so the catalog label alone would be cosmetic there. The
`prepareCall` seam is what makes those calls real: DSH 0.2.2 rejects a late
effort change in `agent/request` (it fails the turn with “use
agent.model.select() before step preparation”), but `prepareCall`'s
`ConfigureCall` hook runs inside the frozen call the loop is about to log and
dispatch.

## Implementation note

`ctx.llm` is a traceable proxy whose reads wrap every method in a second proxy,
so the overrides and their guards use `Symbol.for('cordis.original')` to reach
the raw service. Writing through the proxy also lands on the raw instance, but
the explicit target keeps the guard meaningful. If a future DSH release removes
`llm.resolveModelInfoFor` or `llm.prepareCall`, the plugin row fails at
activation instead of silently reverting to a cosmetic label.

## Selection timing

A model switch reaches `agent.model.select()` before step preparation, which is
the only point DSH accepts a new effort. A call with no stored effort is raised
inside `prepareCall`, after that point and before the header is logged.

## Configuration

Both switches default to `true`; override them in the profile patch when
needed.

```yaml
- id: max-effort
  name: '@local/dsh-max-effort'
  config:
    catalogDefault: true
    callDefault: true
```

`catalogDefault: false` keeps the shipped catalog defaults; `callDefault: false`
stops lifting effort-free calls. Set both to `false` to park the plugin without
uninstalling it. The obsolete `requestFallback` key is ignored.

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
