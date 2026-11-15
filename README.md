# GameRank

**在线版：https://candytea.github.io/gamerank/**

给游戏排序的单页网站：中英文搜索游戏 → 加入排行榜 → 拖拽调整顺序，数据存在浏览器本地。
纯静态、零构建、无依赖，双击 `index.html` 就能用（封面图来自 Steam CDN，需要联网）。

推送 `main` 分支即自动部署到 GitHub Pages（Pages 直接发布仓库根目录，无需 Actions）。

## 运行

```bash
python -m http.server 8080 --bind 127.0.0.1
# 或双击 serve.cmd
```

打开 http://localhost:8080/ 。也可以直接打开 `index.html`（file:// 同样可用）。

## 功能

| 功能 | 说明 |
| --- | --- |
| 搜索联想 | 输入中文或英文即时匹配 `name` / `nameZh` / `aliases`，结果按热度降序；空输入时显示「热门 Top 12 · 库内共 N 款」并可一键进入全部游戏；输入法（IME）组词期间不打断、不误判回车 |
| 浏览全部 | 「浏览全部 N 款游戏」弹窗：全库按热度排序，每次加载 60 条并支持滚动续载，顶部可再筛选 |
| 键盘操作 | ↑ / ↓ 选择、Enter 加入、Esc 关闭，完整 combobox ARIA |
| 排行榜 | 拖拽手柄排序（Pointer Events，支持触屏），另有 ↑ / ↓ 按钮作为无障碍兜底 |
| 存档 | 顶栏「存档」按钮：多份命名存档（新建 / 切换 / 重命名 / 复制 / 删除），每份拥有独立的排行与自定义游戏，切换时自动保存；旧版单档数据会自动迁移成「我的排行」 |
| 自定义游戏 | 库里没有时手动添加（名称 / 中文名 / 分数 / 年份），与内置游戏一起参与排序 |
| 本地保存 | `localStorage` 保存榜单与自定义游戏，刷新不丢；库更新后旧记录不会消失 |
| 分享 | 一键复制纯文本排行，或导出文本 |
| 响应式 | 320px 起的手机布局、44px 触控目标、粘性搜索框；浅色/深色主题 |

## 数据

`data/games.js` 由 `scripts/build_games.py` 从公开来源生成（详见生成文件头的 `window.GAMES_META`）：

- Steam 最热玩榜（`ISteamChartsService/GetMostPlayedGames`）——热度主信号
- Steam 热销榜 / 新品（`store.steampowered.com/api/featuredcategories`）
- Steam 商店接口（`appdetails` / `storesearch`）——中英文名、发行年份、平台、Metacritic 分数、封面
- Metacritic 全时段最高分榜——评分与经典库覆盖面
- IGN 评测页 JSON-LD——IGN 分数
- Metacritic 独占目录：主机独占 / 不上 Steam 的游戏（塞尔达、马力欧、宝可梦、原神等），
  记录 id 为 `mc:<slug>`，封面用 M 站 2:3 竖图；中文名只来自构建脚本里人工维护的
  `CONSOLE_ZH` 表（不猜译名），其余条目标题保持英文。

重新生成：

```bash
python scripts/build_games.py
```

热度 `popularity` 是 0..1 的合成值，数组已按它降序排列；搜索列表直接用这个顺序，所以热门游戏总在前面。

当前快照：**1650 款**（Steam 上架 857 + Metacritic 独占 793），Metascore 覆盖 1565，IGN 覆盖 857，封面 1649。

## 文件

```
index.html          页面结构（含主题引导脚本 + 资源版本号）
styles.css          全部样式与响应式规则
app.js              搜索联想 / 排序 / 持久化
data/games.js       游戏库（window.GAMES + window.GAMES_META）
scripts/build_games.py  数据集构建脚本（带本地缓存）
serve.cmd           Windows 下启动静态服务器
```

`index.html` 里三个资源都带 `?v=<日期>-<游戏数>-<资源摘要>`，构建脚本每次重建都会改写它——
否则浏览器会继续用缓存里的旧库（曾出现页面显示 19 款、实际库已 857 款）。摘要覆盖
`data/games.js`、`app.js`、`styles.css`，所以只改样式或脚本也会让缓存失效。

## 存档

所有数据在浏览器 `localStorage` 的单个键 `gamerank.saves.v1` 里：

```js
{ version: 1, activeId: "s_xxx",
  saves: [{ id, name, createdAt, updatedAt,
            ranking: [{ key }],           // 该存档的排序
            customs: [ … ] }] }           // 该存档的自定义游戏
```

- 顶栏「存档」按钮显示当前存档名，点开可新建 / 切换 / 重命名 / 复制 / 删除。
- 每份存档的排行、自定义游戏互相独立；切换即自动写盘，无需手动保存。
- 旧版 `gamerank.ranking.v1` / `gamerank.custom.v1` 会在首次加载时迁移成一份「我的排行」。
- 分享按钮导出的文本首行带 `【存档名】`，方便区分是谁的榜。

## 共享服务器（两人互看）

默认是纯本地模式。要看到对方的榜，在「存档 → 共享服务器」里填服务地址与口令，
之后所有存档都读写服务器（每 8 秒拉取一次更新；本地模式的数据不受影响，断开即可回到本地）。

**没有“手动上传”这一步**：你每次改动后 0.6 秒自动 PUT 到服务器，对方 8 秒内轮询到并刷新。

**最省事的用法**：连上之后点「复制邀请链接」，把链接发给朋友。链接里带着服务器地址和口令
（`#k=…`），对方点开就自动连上、直接看到你的榜，什么都不用填；链接打开后会自动从地址栏抹掉。

如果站点和 API 部署在同一个域名下，地址栏可以留空（默认用当前站点地址）。

服务端 `server/gamerank_server.py`：Python 标准库 + SQLite，零依赖。

```bash
# 生成口令
TOKEN=$(openssl rand -hex 24)

# 直接跑（也顺便把静态站发出去）
GAMERANK_TOKEN=$TOKEN python3 server/gamerank_server.py \
  --host 127.0.0.1 --port 8787 --db /var/lib/gamerank/boards.db --static /opt/gamerank
```

腾讯云部署要点（`deploy/` 里有现成文件）：

1. 上传 `index.html`、`styles.css`、`app.js`、`data/games.js`、`server/` 到 `/opt/gamerank`。
2. `deploy/gamerank.service` → `/etc/systemd/system/`，把 `GAMERANK_TOKEN` 改成你的口令；
   `useradd -r gamerank && mkdir -p /var/lib/gamerank && chown gamerank /var/lib/gamerank`，
   然后 `systemctl enable --now gamerank`。
3. `deploy/nginx-gamerank.conf` → `/etc/nginx/conf.d/`，改域名与证书路径后 `nginx -t && systemctl reload nginx`。
4. 安全组放行 80/443；**大陆机房域名需 ICP 备案**。
5. 站点是 https 时服务端也必须 https，否则浏览器按混合内容拦截 `/api` 请求。

接口（都需要 `X-GameRank-Token`）：

```
GET    /api/boards             列表
POST   /api/boards             {name} 新建
GET    /api/boards/<id>        单档（含 ranking / customs）
PUT    /api/boards/<id>        {name?, ranking?, customs?} 覆盖写
DELETE /api/boards/<id>        删除
```

这是「最后写入者胜」的简单模型，适合两个人轮流改；同一秒互相改同一条会丢一个人的那次改动。
备份只需拷 `boards.db`（SQLite，直接 `cp` 或 `sqlite3 .backup`）。

## 已知边界

- 封面图直连 Steam CDN 与 Metacritic CDN，离线时不显示图，但名称、分数、排序功能完全可用。
- Metacritic 独占条目没有 Steam 中文名，只有构建脚本 `CONSOLE_ZH` 表里的知名作品能用中文搜到
  （塞尔达、马力欧、宝可梦、原神等），其余用英文名搜索。
- 游戏库是构建时快照，不会实时更新；改库只需重新跑构建脚本。
