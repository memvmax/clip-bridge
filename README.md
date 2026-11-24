# ClipBridge · 跨端剪贴板

在 A 电脑复制，B 电脑（或手机）立刻看到、直接粘贴。一个 HTML 页面 + 一个零依赖 Node 服务，不需要登录、不需要翻墙、不需要数据库。

![node](https://img.shields.io/badge/node-%E2%89%A516-3c873a?style=flat-square&logo=node.js&logoColor=white)
![deps](https://img.shields.io/badge/dependencies-0-blue?style=flat-square)
![size](https://img.shields.io/badge/single--file-98_KB-8b5cf6?style=flat-square)
![license](https://img.shields.io/badge/license-All%20rights%20reserved-lightgrey?style=flat-square)

### 👉 [点这里直接使用](https://clip-bridge-59130.app.workbuddy.host/?sharecode=U24362SXMK)

打开就是你的专属房间，地址栏会自动换成你的房间码；把那条链接丢到手机或另一台电脑，两边的剪贴板就通了。不用装任何东西，也不用注册。

> 链接里的 `sharecode` 是这台部署的访问凭据（不是房间码）。第一次打开后浏览器会记住它，之后直接访问 `https://clip-bridge-59130.app.workbuddy.host/` 就能进。

> Designed & built by [**memvmax**](https://github.com/memvmax) · © 2026 ClipBridge · 保留所有权利

---

## 特性

- **零依赖**：只有 `server.js` + `index.html`，没有 npm 包，`node server.js` 就能跑
- **房间隔离**：一个 8 位房间码 = 一个同步空间，互不干扰；地址栏 `#r=` 可分享
- **实时同步**：1.5s 轮询增量拉取（`since` / `nrev`），后台标签页自动暂停，省流量
- **单条备注**：任意一条记录都能挂一句备注，提醒自己「这是啥来着」
- **置顶 / 搜索 / 清空**：常用内容固定在上方，历史内容随手一搜就有
- **设备管理**：每台设备可改名（改完它发过的内容一起跟着变），可授予「管理」或「仅上传」权限
- **双主题**：自动 / 浅色 / 深色，跟随系统并可手动覆盖，选择本地记住
- **移动端优先**：底部弹层、下拉关闭、安全区内边距，手机上好用；桌面端同样顺手
- **起始页**：第一次打开会走「公链入口 → 分配房间 → 拿到专属链接」三帧引导

## 快速开始

```bash
node server.js          # 默认 http://localhost:3000
PORT=8080 node server.js
```

数据落在 `~/.clipbridge/store.json`（可用 `CLIP_DATA_DIR` 改目录），原子写入 + 防抖落盘。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/push` | 推送一条文本 |
| `GET`  | `/api/pull` | 增量拉取（`since` / `nrev`） |
| `POST` | `/api/delete` | 删除单条 |
| `POST` | `/api/clear` | 清空房间 |
| `POST` | `/api/pin` | 置顶 / 取消置顶 |
| `POST` | `/api/note` | 写入单条备注 |
| `POST` | `/api/rename` | 设备改名（回填历史消息） |
| `POST` | `/api/role` | 设置设备权限（`admin` / `upload`） |
| `POST` | `/api/device/remove` | 移除设备 |
| `GET`  | `/api/peek` | 只读预览房间状态 |

## 容量边界

| 层级 | 上限 |
|---|---|
| 单条文本 | 20,000 字符 |
| 单条备注 | 240 字符 |
| 单房间 | 120 条记录 + 40 台设备 |
| 房间总数 | 3,000（满了淘汰最久未使用） |
| 闲置回收 | 90 天未活动整房清理 |
| 单次请求体 | 512 KB |

纯文本随便用；**不适合当图床或文件盘**（不支持图片 / 附件）。

## 许可

未开源授权，保留所有权利。如需使用请联系作者。
