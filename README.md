# dsh-plugin-lark-cli

Feishu / Lark for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) through the official [`lark-cli`](https://github.com/larksuite/cli): install, bind and keep `lark-cli` up to date from the Plugins page, so the assistant can use the `lark-*` skills.

Two npm packages live here:

| Directory | npm package | What it is |
|---|---|---|
| [`dsh-plugin-lark-cli`](dsh-plugin-lark-cli) | `dsh-plugin-lark-cli` | The DSH bundle to install. Start with its README. |
| [`dsh-plugin-lark-cli-core`](dsh-plugin-lark-cli-core) | `dsh-plugin-lark-cli-core` | The code: host API and the Plugins-page panel. Pulled in by the bundle. |

## Develop

```sh
npm install
npm test                                   # unit tests (no DSH checkout needed)
DSH_ROOT=/path/to/dsh npm run build        # needs a DSH checkout with dependencies installed
DSH_ROOT=/path/to/dsh npm run typecheck
```

## License

MIT, see each package's `LICENSE`.
