# dsh-plugin-lark-cli-core

Implementation package of [`dsh-plugin-lark-cli`](../dsh-plugin-lark-cli): the host half (`lib/index.js`) and the browser half (`lib/client.js`) of the Feishu / lark-cli panel. It is not a bundle by itself; **install `dsh-plugin-lark-cli`**, which depends on this package and carries the bundle layer.

Why two packages: a DSH bundle's own package name is never importable from the runtime of a distribution that ships it built in (only from a profile that installed it), so a bundle's rows reference a separate plugin package — the same split the official bundles use.

See the bundle's README for what it does and how to configure it.
