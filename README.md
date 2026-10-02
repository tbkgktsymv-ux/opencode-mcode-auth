# opencode-mcode-auth

OpenCode provider 插件，把 **MiniMax Code** 订阅接入 [magpie](https://github.com/magpie-ai/magpie) 网关：沿用 MiniMax Code 桌面端已登录的账号（或 MiniMax 账号网页登录），把订阅内的全部模型（`mcode/MiniMax-M3` 等）通过 magpie 提供给任意 agent（Codex、Claude Code、WorkBuddy、OpenCode…）使用。

An OpenCode provider plugin for the **MiniMax Code** subscription: sign in with the MiniMax Code desktop app's account (or a MiniMax account via browser) and use every model your MiniMax Code plan serves from any agent through the magpie gateway.

## 模型 / Models

模型按 `mcode/<模型名>` 命名，例如 `mcode/MiniMax-M3`。插件优先从 MiniMax Code 的本地配置（`~/.minimax/config.yaml`）读取当前订阅提供的模型及上下文/输出上限；读不到时使用内置的 MiniMax 原生模型表。

Models are named `mcode/<model>` (e.g. `mcode/MiniMax-M3`). The plugin reads the plan's models and limits from the MiniMax Code local config (`~/.minimax/config.yaml`) first, falling back to a built-in table of the native MiniMax models.

## 登录方式 / Sign-in methods

- **MiniMax Code 桌面端登录** — 复用桌面端当前登录的账号（读取 `~/.minimax/auth/prod/<region>/mcode-public/auth.json`）。每次请求实时读取；当约 1 小时的 access token 快到期时，插件通过 MiniMax 账号 OAuth 端点（`POST /oauth2/token`，`grant_type=refresh_token`）自动续期，并按桌面端自己的格式（新 generation、原子写、乐观并发）写回，桌面端与插件永不失步。
  Reuses the account the MiniMax Code desktop app is signed in to. The record is read on every request; when the ~1 h access token runs short it is renewed through MiniMax's account OAuth endpoint and written back in the app's own format, so the app and the plugin never drift apart.
- **MiniMax 账号（网页登录）** — 标准 OAuth 设备码流程（code challenge S256）：magpie 自动打开 MiniMax 登录页（一次性 user code 已带在 URL 里），你在浏览器里完成登录，插件用 device_code 轮询 `/oauth2/token` 自动收单。`authorization_pending`（HTTP 400）表示用户还在登录页，属于正常等待；只有真实错误或 300 秒超时才会失败。令牌保存在 magpie 自己的登录存储里，不碰桌面端文件。
  A full OAuth device flow: magpie opens the MiniMax login page automatically, you sign in in the browser, and the plugin polls for the grant until it arrives. Tokens are kept in magpie's own sign-in store; the desktop file is never touched.

## 请求 / Requests

所有模型走 Anthropic Messages API：

```
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages      (cn)
POST https://agent.minimax.io/mavis/api/v1/llm/v1/messages      (en)
```

`Authorization: Bearer mmoat_…`。插件的 `fetch` 为每个请求签名、把 URL 归一到网关实际路由的路径，401 时自动续期一次并重试。

Every request is signed with the account's OAuth access token; on a 401 the plugin renews the token once and retries.

## 安装 / Install

```sh
magpie plugin add <本仓库地址>      # 例如 magpie plugin add github:owner/opencode-mcode-auth
magpie plugin login mcode          # 选择一种登录方式
```

## 许可 / License

MIT
