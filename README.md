# 数字展品使用授权核验应用

供小型展馆使用的 Web 应用：登记数字素材及其**来源关系**、录入各素材的使用**授权**（媒介 / 地区 / 有效期 / 撤销状态），在组展时沿**全部来源链**核验授权，核验通过才可发布，发布时原子固化不可变核验快照。授权后续变更时自动重算资格，仅把不再合格的已发布包标记为「需复核」，原快照始终保留。

## 功能与业务规则

- **素材登记**：维护素材（名称、类型、备注）。
- **来源关系**：以「派生素材 ← 来源素材」有向边登记，支持多条来源链；**添加成环（含自环）的关系会被拒绝**。
- **授权登记**：按素材录入媒介、地区、起止日期、授权方及**撤销**标记；日期必须合法且起 ≤ 止。媒介/地区支持精确匹配，`*` 表示任意媒介/全球。
- **组展核验**：对展览包输入展示媒介、地区与起止日期，系统沿每个所选素材的全部来源路径向上游核验，要求**每个来源节点至少有一份**「未撤销 + 媒介匹配 + 地区匹配 + 有效期覆盖整段使用期」的授权；界面列出所有不合格节点、不合格原因及完整来源路径。
- **发布门槛**：缺少授权、日期非法、起晚于止、素材为空等情况下一律不得发布（HTTP 400/422）。
- **原子发布 + 不可变快照**：发布在单个 SQLite 事务中完成，写入追加式 `snapshots` 记录（发布时的逐节点结论、来源路径、素材清单、来源图与全部相关授权数据）；快照只增不改，已发布包不可编辑、不可删除。
- **依据版本（乐观并发）**：素材 / 来源 / 授权每发生一次变更，核验依据版本号递增；发布时携带核验所见版本号，若提交时依据已被并发编辑改期，发布被拒绝并返回 409 `STALE_BASIS`，前端提示重新核验后重试。
- **授权变更后重算**：任何授权、来源或素材变更后自动按当前数据重算所有已发布包；只有从合格变为不合格的包被置为 `needs_review`（需复核），其快照原样保留；待发布（草稿）包始终在打开/发布时按当前数据重新核验。
- **复核工作流**：策展人可查看「当前合格 / 不再合格」标记与发布快照差异，并把已发布包「克隆为待发布包」重新核验发布。

## 技术栈

- Node.js 20 + Express 4（HTTP / JSON API，静态托管前端）
- SQLite（better-sqlite3，同步事务）
- 浏览器原生 HTML/CSS/JavaScript，无前端构建步骤

## 一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后浏览器打开：

- **http://localhost:3000**

停止 / 重启：

```bash
docker compose down          # 停止（保留数据卷）
docker compose restart       # 重启
```

数据库保存在 Docker 命名卷 `exhibit-data`（容器内 `/data/exhibit.db`，含 WAL 文件），重建镜像不丢数据。彻底清除数据：

```bash
docker compose down -v
```

## 本机直接运行（无 Docker）

需要 Node.js ≥ 20。better-sqlite3 通常使用预编译二进制；若需从源码编译，本机需具备 Python 3、make、g++。

```bash
npm install
npm run init-db      # 初始化/升级数据库（建表幂等，可重复执行）
npm start
```

打开 **http://localhost:3000**。

可选：运行端到端冒烟测试（自动使用临时数据库，覆盖成环拒绝、全链核验、发布门槛、并发过期、快照保留与需复核流转）：

```bash
node test/smoke.js
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `DATA_DIR` | `./data` | 数据目录（不存在会自动创建） |
| `DB_PATH` | `$DATA_DIR/exhibit.db` | SQLite 数据库文件完整路径，设置后覆盖 `DATA_DIR` 推导 |
| `APP_PORT` | `3000` | 仅 Compose 使用：宿主机映射端口，例如 `APP_PORT=8080 docker compose up -d` |

Compose 自定义宿主机端口示例：

```bash
APP_PORT=8080 docker compose up -d --build   # 访问 http://localhost:8080
```

## 数据模型概要

- `materials`：素材
- `source_edges`：来源边（`derived_id → source_id`，唯一约束 + 自环 CHECK，成环在应用层 DFS 拒绝）
- `authorizations`：授权（媒介、地区、起止日期、`revoked`、CHECK 起止合法）
- `packages`：展览包（`draft` / `published` / `needs_review`，`current_eligible` 为按当前数据重算的资格）
- `package_materials`：包的素材清单
- `snapshots`：发布快照（追加不可变；含逐节点结果 JSON 与素材/来源图/授权完整载荷 JSON）
- `meta.basis_version`：核验依据版本，由素材/来源/授权三张表的触发器在增删改时自动 +1

## API 摘要

| 方法 路径 | 说明 |
| --- | --- |
| `GET/POST /api/materials`，`PUT/DELETE /api/materials/:id` | 素材 CRUD |
| `GET/POST /api/edges`，`DELETE /api/edges/:id` | 来源关系（成环返回 409） |
| `GET/POST /api/authorizations`，`PUT/DELETE /api/authorizations/:id` | 授权 CRUD（撤销即 `revoked:true`） |
| `POST /api/verify` | 按素材集 + 媒介/地区/日期执行全链核验，返回逐节点结论与路径 |
| `GET/POST /api/packages`，`GET/PUT/DELETE /api/packages/:id` | 展览包（仅草稿可改可删） |
| `POST /api/packages/:id/publish` | 事务发布；body 可带 `basis_version`，过期返回 409 `STALE_BASIS`；不合格返回 422 |
| `POST /api/packages/:id/clone` | 克隆为待发布包 |
| `POST /api/recompute` | 手动触发已发布包资格重算（数据变更后亦会自动触发） |
| `GET /api/state` | 当前核验依据版本号 |

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/
│   ├── db.js        # SQLite 连接、建表、依据版本触发器
│   ├── verify.js    # 成环检测、来源路径枚举、全链授权核验
│   └── server.js    # Express API、事务发布、资格重算
├── public/          # 浏览器前端（原生 HTML/CSS/JS）
├── test/smoke.js    # 端到端冒烟测试
└── data/            # 本机运行时的 SQLite 数据（自动创建）
```
