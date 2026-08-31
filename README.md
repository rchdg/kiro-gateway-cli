# Kiro Gateway CLI（Node.js）

[English](README_EN.md) | [简体中文](README.md)

一个用 Node.js 实现的 Kiro Gateway——一个透明代理，把 Kiro API（Amazon Q Developer / AWS CodeWhisperer）以 OpenAI 兼容和 Anthropic 兼容的接口暴露出来。

## 环境要求

- Node.js >= 23.4（使用内置的 `node:sqlite` 模块）
- npm

## 安装

```bash
cd kiro-gateway-cli
npm install
```

## 用法

```bash
# 使用默认配置启动（host: 0.0.0.0, port: 8000）
npm start

# 显式使用 serve 子命令（与默认行为相同）
kiro-gateway serve

# 自定义端口 / 主机
kiro-gateway serve --port 9000
kiro-gateway serve --host 127.0.0.1 --port 9000
node bin/kiro-gateway.js serve --port 9000
node bin/kiro-gateway.js --host 127.0.0.1 --port 9000

# 全局安装（添加 kiro-gateway 命令）
npm link
kiro-gateway serve --port 9000
```

### 通过 CLI 参数进行常用配置

最常见的配置项可以作为 CLI 参数传入（优先级最高——会覆盖 `.env` 和环境变量）：

```bash
kiro-gateway serve \
  -k my-super-secret-key \                  # PROXY_API_KEY（可选；不设置 = 无认证）
  -t your_refresh_token \                   # REFRESH_TOKEN（或者改用 -f / -d）
  -f ~/.aws/sso/cache/kiro-auth-token.json  # KIRO_CREDS_FILE（JSON 凭据）
  -d ~/.local/share/kiro-cli/data.sqlite3   # KIRO_CLI_DB_FILE（kiro-cli SQLite）
  -r us-east-1 \                            # KIRO_REGION
  --api-region eu-central-1 \               # KIRO_API_REGION 覆盖
  --profile-arn arn:aws:codewhisperer:... \ # PROFILE_ARN
  --log-level DEBUG \                       # LOG_LEVEL
  --proxy-url http://127.0.0.1:7890 \       # VPN_PROXY_URL（HTTP/HTTPS/SOCKS5）
  --proxy-url socks5h://127.0.0.1:1080 \    # SOCKS5，代理侧解析 DNS（socks5h）
  --proxy-url socks5://127.0.0.1:1080 \     # SOCKS5，客户端侧解析 DNS（socks5）
  --account-system \                        # 启用多账号故障切换
  -H 0.0.0.0 -p 8000                        # 服务器监听地址
```

运行 `kiro-gateway --help` 查看完整列表。

配置优先级（从高到低）：
1. CLI 参数（`--api-key`、`--port`……）
2. 环境变量（`.env` 文件 / 进程环境变量）
3. 默认值（`0.0.0.0:8000`，凭据：`~/.aws/sso/cache/kiro-auth-token.json`）

`serve` 子命令是可选的——直接运行 `kiro-gateway`（不带参数）也会以相同方式启动服务器。

## 配置

复制根目录的 `.env.example` 为 `.env`（放在 `kiro-gateway-cli` 旁边），或者使用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PROXY_API_KEY` | 客户端必须携带的 API 密钥（可选；为空/未设置 = 关闭认证） |
| `REFRESH_TOKEN` | Kiro 刷新令牌（方式二） |
| `KIRO_CREDS_FILE` | Kiro IDE 凭据 JSON 的路径（方式一，推荐；默认：`~/.aws/sso/cache/kiro-auth-token.json`） |
| `KIRO_CLI_DB_FILE` | kiro-cli SQLite 数据库路径（方式三，AWS SSO） |
| `KIRO_REGION` | SSO/认证区域（默认：`us-east-1`） |
| `KIRO_API_REGION` | 覆盖 Q API 区域 |
| `PROFILE_ARN` | AWS CodeWhisperer 配置文件的 ARN 覆盖 |
| `SERVER_HOST` / `SERVER_PORT` | 服务器监听地址 |
| `VPN_PROXY_URL` | 受限网络下的代理：HTTP/HTTPS 或 SOCKS（`socks5://`、代理侧 DNS 用 `socks5h://`、`socks4a://`） |
| `LOG_LEVEL` | `DEBUG`、`INFO`、`WARNING`、`ERROR`（默认：`INFO`） |
| `ACCOUNT_SYSTEM` | 启用多账号故障切换（`true`/`false`） |
| `FAKE_REASONING` | 通过标签注入实现扩展思考（默认：启用） |
| `FIRST_TOKEN_TIMEOUT` | 重试前等待首个 token 的时间（默认：15 秒） |

### 凭据（多账号）

可以在 CLI 旁边放一个 `credentials.json`，用账号数组提供凭据：

```json
[
  { "type": "json", "path": "~/.aws/sso/cache/kiro-auth-token.json", "region": "us-east-1" },
  { "type": "refresh_token", "refresh_token": "your-token" },
  { "type": "sqlite", "path": "~/.local/share/kiro-cli/data.sqlite3" }
]
```

如果 `credentials.json` 不存在，CLI 会从旧的 `.env` 变量（`KIRO_CREDS_FILE` > `REFRESH_TOKEN` > `KIRO_CLI_DB_FILE`）一次性生成它。

## API 端点

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `GET /` | 无 | 健康检查 |
| `GET /health` | 无 | 详细健康检查 |
| `GET /v1/models` | `Authorization: Bearer {PROXY_API_KEY}`（仅当配置了密钥时） | 列出模型 |
| `POST /v1/chat/completions` | Bearer（仅当配置了密钥时） | OpenAI 对话（流式 + 非流式） |
| `POST /v1/messages` | `x-api-key` 或 Bearer（仅当配置了密钥时） | Anthropic messages（流式 + 非流式） |
| `POST /v1/messages/count_tokens` | `x-api-key`（仅当配置了密钥时） | token 估算 |

### 示例

设置 `PROXY_API_KEY` 后，客户端必须携带它：

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

如果没有设置 `PROXY_API_KEY`，则无需认证，可以省略 `Authorization` 头。

## 移植了哪些功能

- **认证**：Kiro Desktop 刷新、AWS SSO OIDC（kiro-cli）、JSON 凭据（包括 Enterprise `clientIdHash` 设备注册）、SQLite 读取 + 读-合并-写令牌刷新
- **模型解析**：四层管线（别名 → 规范化 → 缓存/隐藏 → 透传）
- **转换器**：完整的 OpenAI/Anthropic → Kiro 管线（系统提示词、工具、工具调用/结果、图片、相邻消息合并、角色交替、思考标签注入、JSON schema 清洗）
- **流式**：AWS 事件流解析器、思考块有限状态机、带重试的首 token 超时、OpenAI `chat.completion.chunk` SSE 和 Anthropic Messages SSE 格式
- **HTTP 客户端**：403 令牌刷新重试、429/5xx 指数退避、网络错误分类、客户端断开时按请求中止
- **账号系统**：带粘性索引和熔断器的多账号故障切换、惰性初始化

## 测试

```bash
npm test
```

测试覆盖解析器、思考解析器、模型解析、转换器、错误分类、认证、HTTP 客户端重试、流式格式，以及完整的端到端服务器行为。无需联网。
