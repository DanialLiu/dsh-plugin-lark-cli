# dsh-plugin-lark-cli

Feishu / Lark for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through the official [`lark-cli`](https://github.com/larksuite/cli).

It does one job: get `lark-cli` installed, bound to a Feishu app and kept up to date from the **Plugins** page, so the assistant can use the `lark-*` skills (calendar, docs, messages, drive, sheets, base, tasks, mail, contacts …) in conversations. Everything Feishu-specific is delegated to `lark-cli`; this plugin does not talk to the Feishu Open Platform itself and does not relay chat messages.

## Install

```sh
dsh plugin --profile <name> add dsh-plugin-lark-cli                       # from npm
dsh plugin --profile <name> add ./dsh-plugin-lark-cli-0.1.0.tgz           # from a tarball (the core package must be reachable too, see below)
```

This is a standard DSH bundle (`dsh.bundle`). It depends on [`dsh-plugin-lark-cli-core`](../dsh-plugin-lark-cli-core), the package that holds the code (a bundle's rows reference a separate plugin package; the same split the official bundles use). After installing, restart the app/server once: **Plugins → Installed → dsh-plugin-lark-cli**, and the Feishu panel is on its page.

Requires a DSH version in `engines.dsh` (`>=0.2.2-rc.1 <0.3.0`); other versions are refused at install time. Both packages ship built files only; nothing is built on install, so no build permission (`allowBuilds`) is needed.

When installing from tarballs, install the core tarball first (`dsh plugin add ./dsh-plugin-lark-cli-core-0.1.0.tgz`) or publish both to a registry.

## What the panel does

| Step | What happens |
|---|---|
| **1. lark-cli** | Detects an existing install (config path, the plugin's managed prefix, `PATH`, usual locations — a GUI app does not inherit your shell `PATH`). If missing: one click installs it into `<DSH_HOME>/lark-cli` using the pnpm bundled with the desktop app (no system Node, no sudo). Also shows the version, checks for updates, and upgrades **only when you confirm**. |
| **2. Bind a Feishu app** | **Create a new bot** (lark-cli's own flow: link + QR code, finish in the browser) or **bind an existing app** (App Secret goes to `lark-cli` over stdin only). **Reconfigure** replaces the binding after confirmation. |
| **Personal account** (optional) | Authorize your own account (lark-cli default scope) so the assistant can see *your* calendar/docs/mail; sign out clears only the local sign-in. |
| **Assistant skills** | `lark-cli` embeds its skills; the plugin exports them to `<DSH_HOME>/skills/lark-*` (watched by the stock skill provider, no restart). Skills you installed yourself with `npx skills add larksuite/cli` (in `~/.agents/skills`) are used as they are. |

"Connected" means: installed **and** bound. The personal account is optional and does not change it.

Nothing runs in the background by itself: install, upgrade, bind and authorize are always started by you, one at a time, and can be cancelled.

## Configuration

Row `lark-cli` of this bundle (all optional):

| Field | Default | Meaning |
|---|---|---|
| `cliPath` | empty | Use this `lark-cli`; if it does not work the panel says "not installed" instead of falling back. |
| `installPrefix` | `<DSH_HOME>/lark-cli` | Where the plugin installs and upgrades `lark-cli`. |
| `registry` | empty | npm registry mirror. |
| `statusTimeoutMs` | 8000 | Timeout of one read-only command. |
| `updateCheckTtlMs` | 1800000 | How long an update check result is reused. |
| `installTimeoutMs` | 600000 | Install/upgrade timeout. |
| `bindTimeoutMs` | 600000 | How long to wait for you in the browser. |
| `minCliVersion` | `1.0.49` | Below this the panel asks for an upgrade (`auth qrcode` since 1.0.40, embedded skills since 1.0.49). |

Environment knobs for development: `LARK_CLI_SEARCH_DIRS` (replaces the usual install locations; empty = none), `LARK_CLI_PNPM` (installer command override).

## Security

- App secrets and tokens never appear in responses, logs or the page; the plugin passes secrets to `lark-cli` over stdin and redacts command output.
- Every HTTP route (`/api/lark-cli/*`, reads included) sits behind the host's browser-trust fence (`connection.requestRejection`: Host and cross-site checks), so another web page open in the user's browser cannot drive install, bind or sign-in.
- Output of `lark-cli` is redacted before it reaches a log or a response; the verification link is only ever opened if it is `http(s)`; skill files exported from `lark-cli` can only land inside `<DSH_HOME>/skills`.
- Uninstalling or disabling the plugin does **not** uninstall `lark-cli` and does **not** touch its bindings or authorizations.

## Not included

Receiving messages from Feishu bots, approval cards, or any resident gateway process.

## Using it next to another Feishu plugin

Do not run this together with `dsh-plugin-lark`; the panel warns when both are installed.

## Development

The code lives in [`dsh-plugin-lark-cli-core`](../dsh-plugin-lark-cli-core). The browser half is built with the DSH repository's own client-bundle preset, so building needs a checkout of the DSH repository with its dependencies installed; point `DSH_ROOT` at it:

```sh
cd dsh-plugin-lark-cli-core
DSH_ROOT=/path/to/dsh npm run build       # lib/index.js (host) + lib/client.js (browser)
DSH_ROOT=/path/to/dsh npm run typecheck   # both halves against the DSH sources
npm test
```

`npm pack` in the core package and in this directory produces the two tarballs to publish. Consumers never build anything.
