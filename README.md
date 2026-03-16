# Chrome CDP Daemon

一个常驻的本地 Chrome DevTools Protocol 代理。

它会：
- 读取 Chrome 的 `DevToolsActivePort`
- 建立并保持 browser WebSocket 连接
- 通过目录队列接收命令
- 把执行结果写回结果目录
- 在断线后自动重连

当前实现适合本地自动化、快速验证和会话复用。

## 文件结构

- `chrome_cdp_daemon.js`：daemon 主程序
- `cdp_inbox/`：请求目录
- `cdp_processing/`：处理中目录
- `cdp_outbox/`：结果目录
- `cdp_archive/`：归档目录
- `cdp_state.json`：运行状态
- `cdp_daemon.log`：daemon 日志
- `cdp_daemon.stdout.log`：进程标准输出/错误重定向日志

## 运行前提

1. 已启动 Chrome 并打开远程调试端口
2. Chrome 能生成：

```text
~/Library/Application Support/Google/Chrome/DevToolsActivePort
```

例如：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222
```

## 启动 daemon

```bash
node chrome_cdp_daemon.js
```

后台运行示例：

```bash
node chrome_cdp_daemon.js > cdp_daemon.stdout.log 2>&1
```

## 工作方式

daemon 会轮询 `cdp_inbox/` 下的 `*.json` 请求文件：

1. 把请求原子移动到 `cdp_processing/`
2. 执行命令
3. 把结果写到 `cdp_outbox/<request>.result.json`
4. 把原请求归档到 `cdp_archive/`

这样可以避免 `fs.watch` 带来的重复事件和丢事件问题。

## 请求格式

支持两类请求：

### 1. helper 请求

#### ping

```json
{
  "action": "ping"
}
```

#### 列出 targets

```json
{
  "action": "listTargets"
}
```

#### 新开页面

```json
{
  "action": "newPage",
  "url": "https://www.google.com"
}
```

#### Google 搜索

```json
{
  "action": "searchGoogle",
  "query": "Chrome MCP"
}
```

#### 导航已有页面

```json
{
  "action": "navigate",
  "targetId": "TARGET_ID",
  "url": "https://www.xiaohongshu.com"
}
```

如果不传 `targetId`，会默认选最后一个 page target。

#### 执行 JS

```json
{
  "action": "evaluate",
  "targetId": "TARGET_ID",
  "expression": "document.title"
}
```

可选字段：
- `returnByValue`，默认 `true`
- `awaitPromise`，默认 `true`
- `sessionId`

### 2. raw 请求

可直接发送 CDP method：

```json
{
  "type": "raw",
  "method": "Target.getTargets",
  "params": {}
}
```

如果你传了 `targetId`，且方法不是 `Target.*`，daemon 会自动为该 target attach session。

示例：

```json
{
  "type": "raw",
  "targetId": "TARGET_ID",
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.title",
    "returnByValue": true
  }
}
```

## 结果格式

结果文件位于：

```text
cdp_outbox/<request>.result.json
```

成功示例：

```json
{
  "requestFile": "ping-001.json",
  "handledAt": "2026-03-16T05:26:12.481Z",
  "ok": true,
  "result": {
    "pong": true,
    "pid": 48657,
    "connected": true
  }
}
```

失败示例：

```json
{
  "requestFile": "bad.json",
  "handledAt": "2026-03-16T05:26:12.481Z",
  "ok": false,
  "error": "unknown action: foo"
}
```

## 状态文件

`cdp_state.json` 会记录：
- daemon PID
- 是否已连接
- browser WebSocket URL
- 各工作目录路径
- 已处理请求数
- 最近一次处理的请求文件
- 最近错误
- 当前 session 映射

## 设计说明

当前版本相较于早期原型有这些改进：
- 用轮询代替 `fs.watch`
- 用 `rename` 做请求 claim，减少重复处理
- 增加 processing / archive 目录
- 自动 heartbeat
- WebSocket 断线自动重连
- 更完整的状态记录

## 限制

- 目前仍是文件队列协议，不是 socket / HTTP RPC
- 没有通用事件订阅输出
- 高并发命令场景下不如专门的 RPC 服务优雅
- 主要面向本地单用户自动化

## 后续可扩展方向

- 改成 Unix socket / TCP 本地 RPC
- 拆成 TypeScript 模块化结构
- 增加事件订阅与页面生命周期监听
- 增加 CLI client
