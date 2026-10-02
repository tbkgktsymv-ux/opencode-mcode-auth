# opencode-mcode-auth

**MiniMax M3.1 其实很能打，只是没人把它接出来。**

MiniMax Code 订阅里的 M3.1 / M3.1-Flash-Preview（512K 上下文、支持推理）被低估得厉害：日常 agent 干活的表现经常能跟上第一梯队的旗舰。这个插件把 MiniMax Code 订阅接入 [magpie](https://github.com/yetone/magpie)，让 M3.1 出现在你所有 agent（Codex、Claude Code、WorkBuddy、OpenCode…）的模型列表里，随手就能选、随手就能比。

**Why this exists:** MiniMax's M3.1 family is one of the most underrated models out there — 512K context with solid reasoning. But the MiniMax ecosystem is thin on integrations: nobody has wired it into the routing layer the way DeepSeek and GLM got. This plugin is a working bridge from your existing subscription to any agent, powered by [magpie](https://github.com/yetone/magpie).

## 在 magpie 中使用 / Using it in magpie

**1. 安装插件并登录**（二选一，认的是同一个账号）：

```sh
magpie plugin add github:tbkgktsymv-ux/opencode-mcode-auth

# 方式一：沿用 MiniMax Code 桌面端已登录的账号（推荐，token 自动续期）
magpie plugin login mcode

# 方式二：网页登录（没有桌面端时用，magpie 自动打开登录页）
magpie plugin login mcode mcode
```

**2. 把 M3.1 选给任意 agent**：

```sh
# 命令行
magpie codex mcode/MiniMax-M3.1-Flash-Preview        # Codex 用 M3.1
magpie claude mcode/MiniMax-M3                        # Claude Code 用 M3
magpie models                                         # 看所有 agent 能选到的模型

# 或在 magpie 窗口里：插件 tab → MiniMax Code → 勾选模型（M3.1-Flash-Preview 等），
# 然后在对应 agent 的模型下拉里选 mcode/MiniMax-M3.1-Flash-Preview
```

**3. 按需调上下文窗口和推理档位**：

```sh
# 上下文窗口（默认 256K，也可指定 128K / 1M 等）
magpie model context mcode/MiniMax-M3.1-Flash-Preview 1m

# 推理档位（high / xhigh / max）
magpie codex effort high
```

**4. 看额度**：magpie 的账号列表（`magpie accounts` 或界面右上角）会显示**周额度用量**和重置时间，数据与 MiniMax Code 桌面端同源；额度将尽时 magpie 会按账号顺序自动切换。

```sh
magpie accounts          # 所有订阅的额度和重置时间
magpie accounts add mcode   # 再加一个账号（可选）
```

**5. 进阶**：和别的模型组路由组、设 fallback——

```sh
magpie group add m31 models=mcode/MiniMax-M3.1-Flash-Preview,mcode/MiniMax-M3 routing=order
magpie provider fallback mcode deepseek/deepseek-chat
```

## 模型 / Models

模型按 `mcode/<模型名>` 命名，例如 `mcode/MiniMax-M3`、`mcode/MiniMax-M3.1-Flash-Preview`。插件优先从 MiniMax Code 的本地配置（`~/.minimax/config.yaml`）读取当前订阅提供的模型及上下文/输出上限；读不到时使用内置的 MiniMax 原生模型表。

Models are named `mcode/<model>`. The plugin reads the plan's models and limits from the MiniMax Code local config (`~/.minimax/config.yaml`) first, falling back to a built-in table of the native MiniMax models.

## 登录方式 / Sign-in methods

- **MiniMax Code 桌面端登录** — 复用桌面端当前登录的账号（读取 `~/.minimax/auth/prod/<region>/mcode-public/auth.json`）。每次请求实时读取；当约 1 小时的 access token 快到期时，插件通过 MiniMax 账号 OAuth 端点（`POST /oauth2/token`，`grant_type=refresh_token`）自动续期，并按桌面端自己的格式（新 generation、原子写、乐观并发）写回，桌面端与插件永不失步。
  Reuses the account the MiniMax Code desktop app is signed in to. The record is read on every request; when the ~1 h access token runs short it is renewed through MiniMax's account OAuth endpoint and written back in the app's own format, so the app and the plugin never drift apart.
- **MiniMax 账号（网页登录）** — 标准 OAuth 设备码流程（code challenge S256）：magpie 自动打开 MiniMax 登录页（一次性 user code 已带在 URL 里），你在浏览器里完成登录，插件用 device_code 轮询 `/oauth2/token` 自动收单。`authorization_pending`（HTTP 400）表示用户还在登录页，属于正常等待；只有真实错误或 300 秒超时才会失败。令牌保存在 magpie 自己的登录存储里，不碰桌面端文件。
  A full OAuth device flow: magpie opens the MiniMax login page automatically, you sign in in the browser, and the plugin polls for the grant until it arrives. Tokens are kept in magpie's own sign-in store; the desktop file is never touched.

两种登录方式识别的是同一个账号，会自动合并为一条，不会重复占位。

Both sign-in methods resolve to the same account and are merged into a single entry.

## 请求 / Requests

所有模型走 Anthropic Messages API：

```
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages      (cn)
POST https://agent.minimax.io/mavis/api/v1/llm/v1/messages      (en)
```

`Authorization: Bearer mmoat_…`。插件的 `fetch` 为每个请求签名、把 URL 归一到网关实际路由的路径，401 时自动续期一次并重试。

Every request is signed with the account's OAuth access token; on a 401 the plugin renews the token once and retries.

## 许可 / License

MIT
