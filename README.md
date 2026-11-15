# GameRank

你和其他人打开同一个网址，就能查看大家的命名游戏榜单。自己的修改自动保存到服务器，其他人正在看的榜单通过实时推送更新，无需邀请链接、连接配置或注册。

前端使用原生 HTML / CSS / JavaScript，后端使用 Python 标准库 + SQLite，无需安装第三方依赖。需要 Python 3.10 或更新版本。

## 启动

Windows 双击 `serve.cmd`，Linux / macOS 运行：

```bash
bash start.sh
```

打开 [http://localhost:8080/](http://localhost:8080/)。同一局域网的其他人使用这台电脑的 IP 加 `:8080` 访问；部署到公网服务器后，大家使用该服务器的同一个网址。允许系统防火墙或服务器安全组的对应端口入站。

`GAMERANK_PORT` 可指定端口，Linux 启动脚本还支持 `GAMERANK_HOST`、`GAMERANK_DB`。默认数据库为项目内的 `var/boards.db`，重启服务不会清空榜单。

直接双击 `index.html`，或者只把静态文件放到 GitHub Pages，仍可使用本地排序；页面会提示本地模式。**多人实时共享需要运行上述后端，不能只上传静态页面。**

## 使用方式

1. 每个人打开同一个普通网址，主页直接显示大家的榜单。
2. 新建并命名自己的榜单，例如「小明的排行」，搜索游戏或添加自定义游戏，再拖拽排序。
3. 修改自动保存。其他人打开这份榜单即可实时观看，不用刷新。
4. 其他人的榜单只能查看；可以复制成自己的榜单继续修改。

浏览器自动保存一份私人设备密钥，服务端据此校验榜单的编辑归属。密钥不会写进公开榜单或分享网址。清除浏览器数据、换浏览器或换设备后会获得新身份，旧榜单仍可查看和复制。

升级前已在服务器上的榜单按只读保留；需要继续编辑时，点击「复制到我的榜」即可。

已有本地存档在连接服务器时迁移上传，原本地数据继续保留。尚未同步的修改缓存在当前浏览器，网络恢复后重试；同一份榜单发生版本冲突时不会静默覆盖服务器上的更新。

能访问站点的人可以阅读榜单并创建自己的榜单。这个版本没有好友审核或账号找回功能。

## Linux 服务器常驻运行

把项目上传到服务器任意目录，在该目录运行：

```bash
sudo bash deploy/install.sh
```

安装脚本仅复制网页、游戏库和服务端到 `/opt/gamerank`，安装并启动 systemd 服务，数据库存放在 `/var/lib/gamerank/boards.db`。更新时再次运行安装脚本即可，已有数据库不会被覆盖。

放行 TCP 8080 后，使用 `http://服务器IP:8080/` 访问。查看服务状态和日志：

```bash
systemctl status gamerank
journalctl -u gamerank -f
```

自定义监听地址或端口时，在 `/etc/default/gamerank` 写入 `GAMERANK_HOST=127.0.0.1` 或 `GAMERANK_PORT=8080`，然后 `sudo systemctl restart gamerank`。

已有域名和 HTTPS 证书时，可使用 `deploy/nginx-gamerank.conf`：修改域名与证书路径，并确认反向代理端口与服务一致。`/api/events` 已关闭代理缓冲和压缩，避免实时更新被积压。前端和 API 使用同一域名。旧版共享口令和邀请链接不再需要。

数据库备份可使用 SQLite 在线备份接口：

```bash
sudo -u gamerank python3 -c "import sqlite3; source=sqlite3.connect('/var/lib/gamerank/boards.db'); target=sqlite3.connect('/var/lib/gamerank/boards-backup.db'); source.backup(target); target.close(); source.close()"
```

## 原有功能

- 1650 款游戏的中英文联想搜索，按热度排列；支持浏览全部、键盘选择及中文输入法。
- 命名榜单的新建、切换、重命名、复制、删除；每份榜单的排序及自定义游戏独立。
- 拖拽及上下按钮排序，支持手机；复用游戏行节点，避免排序时封面闪烁。
- 自定义游戏、文本导出、浅色与深色主题。
- 名称顺序可选择「中文优先」或「英文优先」，搜索结果、全部游戏和榜单一起切换；没有译名时使用已有名称。
- 支持列表与格子视图。格子视图在桌面端每行 5 个，较窄屏幕自动改为 3 列或 2 列，保持从左到右、从上到下的排名顺序；两种视图均支持拖拽排序。
- IGN 分数使用红底白字的六边形评分牌，与 Metascore 分开展示，保留原有小数评分。

名称顺序和视图选择只保存在当前浏览器中，不会改变其他人的显示设置或榜单内容。

## 游戏数据

`data/games.js` 是构建时的游戏库快照，来自 Steam 热玩榜、热销榜、新品、商店接口、Metacritic 全时段榜及 IGN 评测数据。当前快照为 1650 款（Steam 857 + Metacritic 独占 793）。封面图从 Steam / Metacritic CDN 加载。

重新生成游戏库：

```bash
python scripts/build_games.py
```

构建脚本会更新页面资源版本号。部分主机独占游戏没有中文译名，可使用英文搜索。游戏库快照与榜单的实时同步是两套独立功能。

## 验证与接口

```bash
node --check app.js
python -m unittest discover -s server -p "test_*.py"
```

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态与实时功能标记 |
| `GET /api/me` | 根据设备密钥获取当前身份 |
| `GET /api/boards` | 大家的榜单摘要 |
| `GET /api/boards/<id>` | 完整榜单 |
| `POST /api/boards` | 新建榜单，可同时传入初始内容 |
| `PUT /api/boards/<id>` | 保存自己的榜单，支持版本校验 |
| `DELETE /api/boards/<id>` | 删除自己的榜单 |
| `GET /api/events` | SSE 实时变更通知，重连时重新获取最新数据 |

身份接口和写操作使用 `X-GameRank-Key` 设备密钥。公开的 `owner` 仅用于显示归属，不能用来冒充作者。网页只公开必要静态资源，不提供数据库、Git 元数据或服务端源文件下载。
