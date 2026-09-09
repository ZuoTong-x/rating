# 图片评分平台项目文档

本文档用于说明当前图片评分平台的架构、技术栈、目录结构、业务流程、数据模型、接口、部署方式和日常使用方式。

文档基于当前代码整理，适用范围如下：

- 当前任务版本：`v3`
- 后端入口：`server/src/index.js`
- 前端入口：`client/src/main.ts`
- 数据库：PostgreSQL
- 生产部署：Docker Compose
- 文档更新时间：2026-09-09

## 1. 项目概述

图片评分平台用于管理图包、项目、任务模板、任务分配和图片排序评分。平台包含两类用户：

- 管理员：负责导入图包、创建项目、配置团队、生成和分配任务、查看统计、导出结果、管理账号和处理反馈。
- 打分人：查看分配给自己的任务，对任务中的图片进行排序、设置并列关系、标记不适用图片或确认正确图片，然后提交结果。

平台的业务对象可以简单理解为：

```text
图包（Package）
  └─ 包含图片、manifest.json、tasks.json 和任务模板

项目（Project）
  └─ 关联一个或多个图包
  └─ 基于图包中的任务模板生成 rating_tasks

任务（Rating Task）
  └─ 关联若干图片
  └─ 分配给一个打分人
  └─ 保存排序、并列关系、排除图片和完成状态
```

## 2. 总体架构

### 2.1 运行架构

```text
浏览器
  │
  │ HTTP
  ▼
Nginx Web 容器
  ├─ 返回 Vue/Vite 构建后的静态文件
  ├─ /api/* 反向代理到 API 容器
  └─ /files/* 反向代理图片和其他文件资源
        │
        ▼
Node.js / Express API 容器
  ├─ 认证、权限和会话
  ├─ 图包上传、断点续传和导入
  ├─ 项目、团队和账号管理
  ├─ 任务生成、分配和回退
  ├─ 评分提交和任务查询
  ├─ 仪表盘统计和异步导出
  └─ 图片资源与缩略图访问
        │
        ├──────── PostgreSQL
        │          ├─ 业务表
        │          ├─ 任务统计表
        │          ├─ 导入作业表
        │          └─ 认证和会话表
        │
        └──────── 持久化文件目录
                   ├─ 原始图片
                   ├─ 缩略图
                   ├─ 上传中的分片
                   ├─ 等待补充 JSON 的 ZIP
                   └─ 异步导出文件
```

### 2.2 任务生成进程

任务生成不会长期占用处理 HTTP 请求的主线程。管理员发起任务生成后，API 服务会：

1. 校验项目、团队、打分人和任务数量。
2. 在 `task_generation_jobs` 中创建作业记录。
3. 返回 `202 Accepted` 和作业 ID。
4. 通过 Node.js `fork` 启动 `task-generation-worker.js`。
5. Worker 读取任务模板，批量创建或分配任务。
6. Worker 持续向父进程发送阶段和进度。
7. API 将作业状态写入数据库，前端轮询状态。

任务生成作业状态包括：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已创建，等待 Worker 开始 |
| `running` | 正在加载模板、写入任务或分配任务 |
| `completed` | 任务生成和分配完成 |
| `failed` | 执行失败，作业中保存错误信息 |

服务重启时，仍处于 `queued` 或 `running` 的任务生成作业会被标记为失败，避免页面继续显示一个实际已经中断的作业。

## 3. 技术栈

### 3.1 前端

| 技术 | 用途 |
| --- | --- |
| Vue 3 | 页面和组件框架 |
| TypeScript | 类型约束和前端业务代码 |
| Vite | 开发服务器和生产构建 |
| Naive UI | 表单、表格、弹窗、分页、上传、布局等组件 |
| Pinia | 任务栈等跨组件状态管理 |
| Vue Router | 管理端和打分端路由 |
| Chart.js | 仪表盘图表 |
| ExcelJS | 浏览器端读取任务分配表 |

### 3.2 后端

| 技术 | 用途 |
| --- | --- |
| Node.js 22 | 服务端运行时 |
| Express 4 | HTTP API 和中间件 |
| `pg` | PostgreSQL 驱动 |
| `yauzl` | ZIP64 压缩包读取 |
| `sharp` | 图片元信息读取和缩略图生成 |
| `multer` | multipart 文件上传 |
| `ExcelJS` | 服务端读取和生成 Excel |
| `crypto.scrypt` | 密码哈希 |
| `AsyncLocalStorage` | 请求级数据库事务上下文 |

### 3.3 基础设施

| 组件 | 当前配置 |
| --- | --- |
| PostgreSQL | `postgres:18-trixie` |
| API 容器 | `node:22-alpine` |
| Web 容器 | `nginx:1.27-alpine` |
| 编排 | Docker Compose |
| 默认 Web 端口 | `8080` |
| API 容器端口 | `3000` |

## 4. 代码目录

```text
.
├─ client/                         前端工程
│  ├─ src/
│  │  ├─ components/               通用组件
│  │  ├─ composables/              Vue 状态和组合逻辑
│  │  ├─ config/                   导航配置
│  │  ├─ constants/                评分维度等常量
│  │  ├─ features/tasks/           任务评分相关组件
│  │  ├─ layouts/                  应用和管理端布局
│  │  ├─ services/                 HTTP、认证、图片和任务 API
│  │  ├─ stores/                   Pinia Store
│  │  ├─ types/                    TypeScript 类型
│  │  ├─ utils/                    时间、分配表解析等工具
│  │  ├─ views/                    页面级组件
│  │  ├─ main.ts                   Vue、路由和权限入口
│  │  └─ style.css                 全局样式
│  ├─ Dockerfile
│  ├─ nginx.conf
│  ├─ package.json
│  └─ vite.config.ts
│
├─ server/                         后端工程
│  ├─ src/
│  │  ├─ app.js                    Express 应用和主要业务逻辑
│  │  ├─ index.js                  启动 API 监听端口
│  │  ├─ postgres.js               数据库适配和事务上下文
│  │  ├─ postgres-schema.sql       数据库表、索引和触发器
│  │  ├─ task-generation-worker.js 任务生成子进程
│  │  ├─ image-assets.js            原图和缩略图路径处理
│  │  ├─ import-local.js            SFTP/inbox 本地导入命令
│  │  ├─ backfill-thumbnails.js     历史图片缩略图补生成
│  │  ├─ migrate-sqlite-to-postgres.js SQLite 迁移工具
│  │  └─ services/
│  │     ├─ admin-dashboard.js      仪表盘统计和导出逻辑
│  │     └─ admin-scoring.js        打分管理、查询和回退逻辑
│  ├─ Dockerfile
│  └─ package.json
│
├─ docs/                            项目和数据格式文档
│  ├─ PROJECT_DOCUMENTATION.md      本文档
│  ├─ ZIP_TASKS_FORMAT.md            tasks.json 格式
│  ├─ tasks.example.json             任务 JSON 示例
│  └─ SFTP_IMPORT.md                 SFTP 导入说明
│
├─ scripts/                         数据处理和发布脚本
├─ docker-compose.yml                生产编排配置
├─ DEPLOY.md                         部署、备份和迁移说明
├─ README.md                         快速开始
├─ .env.example                     环境变量模板
└─ package.json                      根目录开发脚本
```

`server/src/app.js` 当前承担了较多业务职责，包括上传、项目、任务、认证、评分和资源接口。它是系统的主要业务入口，拆分服务时必须注意共享的数据库语句、缓存失效逻辑和事务上下文。

## 5. 领域模型

### 5.1 图包与项目

系统中数据库表 `subjects` 表示已经导入的图包。历史接口仍使用 `subject` 命名，因此代码中会同时出现 `subjectId` 和 `packageId`。

- `subjects`：图包本体，保存图片数量、目录数量、存储根目录和导入状态。
- `projects`：业务项目，保存项目名称、任务状态和主图包 ID。
- `project_packages`：项目和图包的多对多关联表。

当前项目可以关联多个图包，但 `projects.packageId` 仍保存第一个主图包，用于兼容旧数据和旧接口。

### 5.2 任务模板与实际任务

- `subject_task_templates`：从 `tasks.json` 校验后生成的任务模板。
- `subject_task_template_items`：模板中的图片和图片角色。
- `rating_tasks`：项目真正生成并分配给打分人的任务。
- `rating_task_items`：实际任务中的图片、顺序和角色。

模板是图包级别的，实际任务是项目级别的。同一个图包可以被多个项目复用，但每个项目生成的任务 ID 根据项目、任务版本、任务类型和图片集合确定。

### 5.3 任务状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 任务已经生成，但尚未分配给打分人 |
| `assigned` | 任务已分配，等待打分 |
| `completed` | 打分人已经提交 |

项目状态：

| 状态 | 含义 |
| --- | --- |
| `task_pending` | 项目尚未开始下发任务 |
| `scoring` | 项目存在已生成、已分配或正在完成的任务 |
| `task_completed` | 当前任务版本中没有待分配或未完成任务 |

图包导入状态：

| 状态 | 含义 |
| --- | --- |
| `importing` | 正在解压或写入图片 |
| `imported` | 图包导入完成 |
| `failed` | 图包导入失败 |

## 6. 前端页面和功能

### 6.1 路由

路由定义位于 `client/src/main.ts`。

#### 公共路由

| 路由 | 页面 |
| --- | --- |
| `/login` | 登录页 |

#### 管理端路由

| 路由 | 页面 |
| --- | --- |
| `/admin` | 管理仪表盘 |
| `/admin/packages` | 图包管理 |
| `/admin/packages/:subjectId` | 图包图片浏览 |
| `/admin/projects` | 项目管理 |
| `/admin/tasks` | 任务管理入口 |
| `/admin/projects/:subjectId/tasks` | 项目任务列表和任务报告 |
| `/admin/scoring` | 打分管理 |
| `/admin/accounts` | 打分账号管理 |
| `/admin/teams` | 团队管理 |
| `/admin/feedbacks` | 问题反馈管理 |

#### 打分端路由

| 路由 | 页面 |
| --- | --- |
| `/` | 任务列表和打分弹窗 |
| `/feedbacks` | 打分人问题反馈 |

### 6.2 管理仪表盘

页面文件：`client/src/views/AdminDashboardView.vue`

当前仪表盘包含：

- 项目数量、完成项目数量、团队数量、可用打分人数。
- 当前任务版本的任务总数、待分配数、已分配数和已完成数。
- 选定项目的图包、图片、模板、任务状态和完成率。
- 按小时统计的完成任务趋势。
- 打分人进度和团队进度。
- 按打分人或团队查看工作量。
- 项目任务明细导出。
- 打分人已完成任务导出。
- 团队成员任务汇总导出。
- 项目任务 Excel 报告导出。

仪表盘的统计数据主要依赖 `project_task_stats` 和 `scorer_task_stats`，避免所有页面请求都直接扫描完整的 `rating_tasks` 表。

### 6.3 图包管理

页面文件：`client/src/views/AdminProjectView.vue`

功能包括：

- 上传 ZIP 图包。
- 显示上传进度和导入处理进度。
- 显示图片数、目录数、导入状态。
- 查看图包图片。
- 删除未关联项目的图包。
- 对 JSON 校验失败的图包补充上传修正后的 JSON。

上传失败时，任务栈会保留错误状态。若失败原因是 `manifest.json` 或 `tasks.json` 可修复错误，图包会进入“等待补充 JSON”状态，原始图片 ZIP 会被保留，不需要重新上传图片。

### 6.4 项目管理

页面文件：`client/src/views/AdminProjectsView.vue`

功能包括：

- 创建项目。
- 编辑项目名称和关联图包。
- 一个项目关联多个图包。
- 查看项目任务可用数量。
- 选择团队和打分人。
- 按打分人设置任务数量。
- 导入 XLSX 任务分配表。
- 启动任务生成和分配作业。
- 查看后台任务生成进度。
- 删除项目。

创建项目时必须选择至少一个已经完成导入的图包。项目已经生成任务后，不能更换关联图包。

### 6.5 任务管理

页面文件：

- `client/src/views/AdminTaskManagerView.vue`
- `client/src/views/AdminTaskView.vue`

功能包括：

- 按项目查看任务。
- 按任务状态筛选。
- 按评分维度筛选。
- 按打分人筛选。
- 查看任务中的图片缩略图。
- 打开任务详情。
- 查看项目级任务统计。
- 查看维度分布和打分人分布。
- 重新分配未完成任务。
- 导出项目任务报告。

重新分配支持两种来源：

1. 从当前项目所有未分配任务中重新分配。
2. 从指定打分人的已分配未完成任务中转移。

### 6.6 打分端

页面文件：`client/src/views/RatingView.vue`

当前打分端功能包括：

- 默认每页显示 5 条任务。
- 按项目和评分维度筛选。
- 查看未完成任务和已完成任务数量。
- 查看整体完成进度。
- 打开任务评分弹窗。
- 拖拽图片排序。
- 点击图片之间的关系按钮切换 `>` 和 `=`。
- 对支持该能力的维度标记图片为“不适用”。
- 对文字正确性和肢体正确性维度标记图片为“正确”。
- 保存完成任务。
- 保存后直接加载下一条任务。
- 关闭弹窗时刷新任务列表。
- 任务完成后本地更新统计数量，降低重复查询。

任务排序弹窗文件：`client/src/features/tasks/components/TaskRankingDialog.vue`

提交结果主要包括：

- 排序图片 ID 数组。
- 相邻图片的关系数组。
- 不适用图片 ID 数组。
- 确认正确图片 ID 数组。
- 提交方式：`direct` 或 `ranked`。
- 排序操作次数。
- 任务开始时间、完成时间和耗时。

### 6.7 账号和团队管理

账号页面：`client/src/views/AdminAccountView.vue`

- 创建单个打分账号。
- 批量创建打分账号。
- 设置账号所属团队。
- 编辑账号团队。
- 启用或禁用账号。
- 管理打分人密码。
- 生成 16 位随机强密码。
- 查看密码状态，但不查看密码明文。

团队页面：`client/src/views/AdminTeamsView.vue`

- 创建团队。
- 修改团队名称。
- 启用或禁用团队。
- 删除没有关联账号和项目的团队。

账号密码要求：

- 长度至少 8 位。
- 包含大写字母。
- 包含小写字母。
- 包含特殊字符。

### 6.8 问题反馈

打分人可以提交：

- 问题标题。
- 问题类型。
- 问题描述。
- 最多 5 张反馈图片。

管理员可以：

- 查看反馈列表。
- 回复反馈。
- 将反馈标记为处理中。
- 将反馈标记为已解决。

反馈数据保存在 `feedbacks` 和 `feedback_messages` 表中，图片保存在上传目录的 `feedback` 子目录。

## 7. 核心业务流程

### 7.1 图包导入流程

前端主要使用可续传上传协议，调用流程如下：

```text
POST /api/import/uploads
        │
        ▼
创建上传会话，返回 uploadId 和 uploadUrl
        │
        ▼
HEAD /api/import/uploads/:uploadId
        │
        ▼
查询服务器当前偏移量
        │
        ▼
PATCH /api/import/uploads/:uploadId
        │
        ▼
以 12 MB 左右的分片连续上传
        │
        ▼
上传最后一个分片后创建 import_jobs
        │
        ▼
GET /api/import/uploads/:uploadId/status
        │
        ▼
合并 ZIP、解压图片、生成缩略图、校验 JSON、写入数据库
```

前端实现位于 `client/src/services/images.ts`，主要特性：

- 上传会话写入浏览器 `localStorage`。
- 刷新页面后可以探测服务端偏移量并续传。
- 单个分片失败会自动重试。
- 遇到偏移不匹配时，以服务端返回的偏移量继续。
- 网络中断后会重新探测上传会话。
- 上传完成后每 10 秒查询一次导入状态。

服务端导入阶段：

1. 检查 ZIP 大小、条目数量和解压总大小。
2. 读取 ZIP 根目录中的 `manifest.json`。
3. 读取 ZIP 根目录中的 `tasks.json` 或 `task.json`。
4. 清理相对路径并处理中文文件名。
5. 解压图片并保存到图包目录。
6. 为图片生成 WebP 缩略图。
7. 通过路径优先、文件名兜底匹配 manifest。
8. 校验任务 ID、评分维度、图片引用、图片角色和重复任务。
9. 开启短数据库事务，批量写入图包、图片、任务模板和模板图片。
10. 更新图包图片数、目录数和导入状态。

文件处理和图片解压在事务外完成，只有最终数据库写入阶段使用事务，减少数据库事务持有时间。

### 7.2 补充 JSON 流程

当原始 ZIP 中 JSON 存在可修复错误时：

1. 导入作业进入 `awaiting_json`。
2. 原始 ZIP 被移动到 `_pending-json` 目录。
3. 数据库中的 `import_jobs.status` 保存为 `awaiting_json`。
4. 管理端显示“补充 JSON”操作。
5. 管理员上传只包含 `manifest.json` 或 `tasks.json` 的 ZIP。
6. 服务端禁止补充 ZIP 包含图片文件。
7. 服务端重新读取原始图片 ZIP，并使用补充 JSON 重新处理。
8. 成功后写入数据库并清理原始临时文件。

补充 JSON ZIP 的限制：

- 文件必须是 ZIP。
- 只能包含 JSON 文件或目录。
- 不应重新包含图片。
- JSON 文件必须放在 ZIP 根目录。

### 7.3 创建项目流程

```text
管理员选择项目名称和图包
        │
        ▼
校验图包存在且状态为 imported
        │
        ▼
创建 projects 记录
        │
        ▼
写入 project_packages 关联
        │
        ▼
返回项目及图包统计
```

项目创建不会立即生成 `rating_tasks`。任务只有在管理员点击任务生成并提交分配计划后才会落地。

### 7.4 任务生成和分配流程

管理员提交的数据结构大致如下：

```json
{
  "teamIds": ["team-id"],
  "teamMatchMode": "all",
  "allocations": [
    { "scorer": "张三", "taskCount": 5000 },
    { "scorer": "李四", "taskCount": 5000 }
  ]
}
```

处理步骤：

1. 检查项目处于 `task_pending` 或 `scoring` 状态。
2. 检查团队已启用。
3. 查询团队内可用打分账号。
4. 校验分配表中的账号属于所选团队。
5. 计算本次请求的任务总数。
6. 优先取项目已有的 `pending` 任务。
7. 如果已有任务不足，再从项目关联图包中加载未物化的任务模板。
8. 按评分维度分组。
9. 根据每个打分人的目标数量计算维度配额。
10. 按配额轮转生成分配计划。
11. 新模板对应的任务在批量插入时直接写入 `assigned` 和 `scorer`。
12. 历史 `pending` 任务通过批量 `UPDATE` 分配。
13. 重建项目和打分人统计表。
14. 更新项目团队关联和项目状态。
15. 返回任务总数、已创建数量、已分配数量和剩余未分配数量。

任务写入和分配默认每批 1000 条，可通过环境变量调整：

```text
TASK_WRITE_BATCH_SIZE=1000
TASK_ASSIGN_BATCH_SIZE=1000
```

当前实现使用 PostgreSQL 事务级变量：

```sql
SET LOCAL app.skip_rating_task_stats = 'on'
```

批量生成期间跳过逐行统计触发器，批量写入后再通过聚合 SQL 重建统计，避免一次下发大量任务时每行都更新统计表。

### 7.5 维度感知分配算法

分配函数位于 `server/src/app.js` 的 `buildDimensionAwareAssignmentPlan`。

算法特征：

- 先按 `criterion` 或 `taskType` 将候选任务分组。
- 每个维度按照各打分人目标任务数占总目标任务数的比例计算理想配额。
- 先取配额整数部分。
- 剩余任务按照小数部分从大到小分配。
- 同一维度内使用轮转方式安排具体任务。
- 最终校验每个打分人的任务数必须等于目标数量。

这个算法可以降低“某个打分人只拿到某一个维度”的概率，并且在任务量充足时让各人的维度比例接近总体分配比例。但如果某个维度的任务数量少于打分人数，不能保证每个人都一定拿到该维度任务。

### 7.6 打分提交流程

```text
打分人打开任务列表
        │
        ▼
GET /api/tasks/assigned
        │
        ▼
打开任务详情
GET /api/tasks/:id
        │
        ▼
拖拽排序、切换 >/=、标记不适用或正确
        │
        ▼
POST /api/tasks/:id/complete
        │
        ▼
事务内将 assigned 改为 completed
        │
        ▼
数据库触发器更新任务统计
        │
        ▼
返回保存后的任务
        │
        ├─ 继续打分：查询下一条任务
        └─ 关闭弹窗：刷新列表
```

完成任务时，服务端会再次校验：

- 任务属于当前打分人。
- 任务状态仍然是 `assigned`。
- 排序图片完整且没有重复。
- 排除图片属于当前任务。
- 确认正确图片属于当前任务。
- 排除图片和确认正确图片不能重叠。
- `>` 或 `=` 关系数量正确。
- 打分耗时和排序操作次数格式正确。

重复提交同一个已完成任务时，如果任务仍属于当前打分人，服务端会返回当前任务，避免前端因为网络重试产生重复错误。

### 7.7 项目删除流程

项目删除和图包删除是两个不同操作。

删除项目时：

1. 检查项目存在。
2. 如果任务生成作业仍在执行，拒绝删除。
3. 删除该项目的 `pending` 和 `assigned` 任务。
4. 删除项目和用户的相关链接。
5. 删除项目记录。
6. 保留图包、图片和已完成任务历史。

项目删除不会删除图包文件，也不会删除 `subjects` 或 `images`。

删除图包时：

1. 检查图包没有被项目关联。
2. 先标记 `deletionRequestedAt`。
3. 立即返回排队删除结果。
4. 后台删除图包存储目录。
5. 删除图包数据库记录。
6. 通过外键级联清理图片、模板和模板图片等关联数据。

## 8. 后端模块

### 8.1 Express 中间件顺序

`server/src/app.js` 的主要顺序如下：

1. 读取环境变量。
2. 初始化 PostgreSQL 连接池并执行数据库 schema。
3. 创建上传、分片、反馈和分配表的 Multer 配置。
4. 创建上传目录、临时目录和导出目录。
5. 注册 CORS。
6. 注册 JSON body parser。
7. 为请求建立数据库事务上下文。
8. 注册 `/files` 静态资源。
9. 注册登录和验证码接口。
10. 注册 `/api` 认证中间件。
11. 注册修改密码、退出登录接口。
12. 注册强制修改密码中间件。
13. 注册管理员和打分人权限中间件。
14. 注册各业务接口。
15. 注册统一错误处理器。
16. 启动清理过期作业、会话、验证码和临时文件。

### 8.2 数据库适配层

文件：`server/src/postgres.js`

数据库适配层提供了一个接近 SQLite 写法的轻量接口：

```js
db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
db.prepare("SELECT * FROM users WHERE role = ?").all("scorer");
db.prepare("UPDATE users SET status = ? WHERE id = ?").run("enabled", id);
```

适配层会：

- 将 `?` 转换为 PostgreSQL 的 `$1`、`$2` 参数。
- 将 `@name` 命名参数转换为位置参数。
- 将 PostgreSQL 返回的全小写列名映射为代码中的驼峰字段。
- 使用连接池执行普通查询。
- 在事务上下文中固定使用同一个 PostgreSQL client。

事务必须在 `runWithDatabaseContext` 创建的上下文中启动：

```js
await db.exec("BEGIN");
try {
  // 事务中的查询和写入
  await db.exec("COMMIT");
} catch (error) {
  await db.exec("ROLLBACK");
  throw error;
}
```

HTTP 请求已经由中间件自动建立该上下文。独立脚本如果需要事务，必须显式使用 `runWithDatabaseContext`。

### 8.3 统计服务

文件：`server/src/services/admin-dashboard.js`

服务职责：

- 仪表盘总览统计。
- 项目汇总。
- 打分人进度。
- 团队进度。
- 按小时的完成任务统计。
- 打分人和团队导出。
- 项目完成任务 JSON 导出。
- 项目任务 Excel 报告。

文件：`server/src/services/admin-scoring.js`

服务职责：

- 打分管理汇总。
- 已完成任务记录分页。
- 提交方式和耗时筛选。
- 回退任务预览。
- 异步回退任务。

## 9. API 接口目录

以下接口均以 `/api` 为前缀。除登录和验证码接口外，默认需要有效会话。

### 9.1 认证接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | 公开 | 登录并写入 HttpOnly 会话 Cookie |
| `POST` | `/api/auth/captcha` | 公开 | 创建图形验证码 |
| `GET` | `/api/auth/session` | 登录用户 | 获取当前会话用户 |
| `POST` | `/api/auth/change-password` | 登录用户 | 修改自己的密码 |
| `POST` | `/api/auth/logout` | 登录用户 | 删除会话并清理 Cookie |

### 9.2 管理员导出和仪表盘

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/admin/exports` | 管理员 | 创建异步导出作业 |
| `GET` | `/api/admin/exports/:jobId` | 管理员 | 查询导出进度 |
| `GET` | `/api/admin/exports/:jobId/download` | 管理员 | 下载完成的导出文件 |
| `GET` | `/api/admin/dashboard` | 管理员 | 获取仪表盘组合数据 |
| `GET` | `/api/admin/dashboard/stats` | 管理员 | 获取基础指标 |
| `GET` | `/api/admin/dashboard/project-summary` | 管理员 | 获取项目汇总 |
| `GET` | `/api/admin/dashboard/charts` | 管理员 | 获取图表数据 |
| `GET` | `/api/admin/dashboard/average-duration` | 管理员 | 获取平均打分时间 |
| `GET` | `/api/admin/dashboard/workload` | 管理员 | 获取打分人或团队工作量 |

旧版导出接口仍保留：

- `/api/admin/tasks/completed/export`
- `/api/admin/scorers/task-summary/export`
- `/api/admin/scorers/completed/export`
- `/api/admin/teams/task-summary/export`

### 9.3 账号和团队

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/users/scorers` | 管理员 | 分页查询打分账号 |
| `POST` | `/api/users/scorers` | 管理员 | 创建单个账号 |
| `POST` | `/api/users/scorers/batch` | 管理员 | 批量创建账号 |
| `PATCH` | `/api/users/scorers/:id` | 管理员 | 修改账号、密码或状态 |
| `DELETE` | `/api/users/scorers/:id` | 管理员 | 删除打分账号 |
| `GET` | `/api/teams` | 管理员 | 查询团队 |
| `POST` | `/api/teams` | 管理员 | 创建团队 |
| `PATCH` | `/api/teams/:id` | 管理员 | 修改团队 |
| `DELETE` | `/api/teams/:id` | 管理员 | 删除未使用团队 |
| `GET` | `/api/teams/scorers` | 管理员 | 查询团队内打分人 |

管理员账号没有走打分账号删除接口，因此不能通过该接口删除管理员。

### 9.4 图包和上传

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/subjects` | 登录用户 | 查询当前用户可见图包 |
| `POST` | `/api/import` | 管理员 | 传统 multipart ZIP 导入 |
| `OPTIONS` | `/api/import/uploads` | 管理员 | 查询可续传上传能力 |
| `POST` | `/api/import/uploads` | 管理员 | 创建可续传会话 |
| `HEAD` | `/api/import/uploads/:uploadId` | 管理员 | 查询上传偏移 |
| `PATCH` | `/api/import/uploads/:uploadId` | 管理员 | 写入一个上传分片 |
| `GET` | `/api/import/uploads/:uploadId/status` | 管理员 | 查询上传或导入状态 |
| `GET` | `/api/import/pending-json` | 管理员 | 查询等待补充 JSON 的作业 |
| `POST` | `/api/import/uploads/:uploadId/supplement-json` | 管理员 | 上传补充 JSON ZIP |
| `DELETE` | `/api/import/uploads/:uploadId` | 管理员 | 取消或清理上传作业 |
| `POST` | `/api/import/chunks/:uploadId/parts/:index` | 管理员 | 旧版分片上传 |
| `POST` | `/api/import/chunks/:uploadId/complete` | 管理员 | 提交旧版分片合并 |
| `GET` | `/api/import/chunks/:uploadId/status` | 管理员 | 查询旧版分片作业 |

### 9.5 项目和任务

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | 登录用户 | 查询项目 |
| `POST` | `/api/projects` | 管理员 | 创建项目 |
| `GET` | `/api/projects/:id` | 登录用户 | 查询项目详情 |
| `PATCH` | `/api/projects/:id` | 管理员 | 修改项目 |
| `DELETE` | `/api/projects/:id` | 管理员 | 删除项目及未完成任务 |
| `GET` | `/api/projects/:id/tasks` | 管理员 | 分页查询项目任务 |
| `GET` | `/api/projects/:id/tasks/options` | 管理员 | 查询任务筛选选项 |
| `GET` | `/api/projects/:id/tasks/:taskId` | 管理员 | 查询任务详情 |
| `POST` | `/api/projects/:id/tasks/generate` | 管理员 | 创建任务生成作业 |
| `GET` | `/api/projects/:id/tasks/generate/:jobId` | 管理员 | 查询任务生成进度 |
| `POST` | `/api/projects/:id/tasks/allocations/import` | 管理员 | 解析 XLSX 分配表 |
| `GET` | `/api/projects/:id/tasks/reassignment-options` | 管理员 | 获取重新分配选项 |
| `POST` | `/api/projects/:id/tasks/reassign` | 管理员 | 重新分配任务 |

兼容的 `/api/subjects/:id/tasks/*` 路径也保留，用于旧页面和旧数据访问。

### 9.6 打分端

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/tasks/assigned/options` | 打分人 | 查询已分配项目 |
| `GET` | `/api/tasks/assigned` | 打分人 | 查询当前打分人的任务 |
| `GET` | `/api/tasks/:id` | 打分人 | 查询任务详情 |
| `POST` | `/api/tasks/:id/complete` | 打分人 | 首次提交任务 |
| `PUT` | `/api/tasks/:id/complete` | 打分人 | 修改已完成任务 |
| `GET` | `/api/scorer/dashboard` | 打分人 | 查询个人任务统计 |

### 9.7 图片、评分和反馈

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/categories` | 登录用户 | 查询图片分类 |
| `GET` | `/api/scorers` | 登录用户 | 查询图片评分人 |
| `GET` | `/api/images` | 登录用户 | 分页查询图片 |
| `PUT` | `/api/images/:id/score` | 管理员或有权限打分人 | 保存图片维度分数 |
| `GET` | `/api/feedbacks` | 登录用户 | 查询反馈 |
| `POST` | `/api/feedbacks` | 打分人 | 提交反馈 |
| `PUT` | `/api/feedbacks/:id/reply` | 管理员 | 回复反馈 |
| `POST` | `/api/feedbacks/:id/messages` | 打分人 | 追加反馈消息 |
| `PUT` | `/api/feedbacks/:id/status` | 登录用户 | 修改反馈状态 |

## 10. 数据库结构

数据库 schema 位于 `server/src/postgres-schema.sql`。

### 10.1 用户和认证

| 表 | 作用 |
| --- | --- |
| `users` | 管理员和打分账号、密码哈希、状态、首次改密标志、失败次数和锁定时间 |
| `user_sessions` | HttpOnly 会话 Cookie 对应的哈希 Token |
| `auth_login_attempts` | 登录失败记录和来源 IP |
| `auth_ip_blocks` | 历史 IP 封禁兼容表，当前应用逻辑不再按 IP 判定账号锁定 |
| `auth_captcha_challenges` | 图形验证码挑战、哈希答案、过期时间和使用时间 |

### 10.2 导入和图包

| 表 | 作用 |
| --- | --- |
| `import_jobs` | 可续传上传和异步导入作业 |
| `subjects` | 图包元数据和删除标记 |
| `images` | 图片路径、缩略图、manifest 数据和图片评分字段 |
| `subject_task_templates` | 从 `tasks.json` 生成的任务模板 |
| `subject_task_template_items` | 模板中的图片和角色 |

### 10.3 项目和分配

| 表 | 作用 |
| --- | --- |
| `projects` | 项目元数据和项目任务状态 |
| `project_packages` | 项目关联图包 |
| `teams` | 团队 |
| `user_teams` | 账号和团队关系 |
| `project_teams` | 项目和团队关系 |
| `user_projects` | 用户和图包的历史关联表 |
| `task_generation_jobs` | 任务生成作业状态和进度 |

### 10.4 任务和统计

| 表 | 作用 |
| --- | --- |
| `rating_tasks` | 实际任务、状态、打分人和提交结果 |
| `rating_task_items` | 任务中的图片、顺序和角色 |
| `project_task_stats` | 项目任务总数、待分配、已分配和已完成计数 |
| `scorer_task_stats` | 打分人按项目的已分配和已完成计数 |
| `dashboard_completion_hour_stats` | 按任务版本和小时统计完成数量 |
| `image_pair_edges` | 图片两两关系统计，为后续排序分析保留 |

### 10.5 反馈

| 表 | 作用 |
| --- | --- |
| `feedbacks` | 反馈主体、状态、答复和附件路径 |
| `feedback_messages` | 反馈对话消息 |

### 10.6 任务统计触发器

数据库函数 `sync_rating_task_stats` 绑定在 `rating_tasks` 的新增、更新和删除操作上。

正常评分提交时，触发器负责：

- 更新项目任务计数。
- 更新打分人任务计数。
- 更新按小时完成任务计数。
- 删除已经归零的打分人统计行。

大批量任务写入时，服务端使用事务级配置跳过逐行触发器，然后执行：

- `refreshProjectTaskStats(projectId)`
- 重建 `project_task_stats`
- 重建 `scorer_task_stats`

这样可以避免十万级任务写入时每一行都重复执行多次统计更新。

## 11. ZIP 和数据格式

### 11.1 ZIP 基本结构

```text
example.zip
├─ image-001.png
├─ 目录1/
│  └─ image-002.webp
├─ manifest.json       可选
└─ tasks.json          可选
```

支持的图片扩展名：

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.gif`

目录名为 `信息图` 的图片会被标记为信息图图片，并在前端使用对应的附加评分维度。

### 11.2 manifest.json

`manifest.json` 必须位于 ZIP 根目录。服务端优先使用路径匹配：

1. `src_rel_path`
2. `dest_rel_path`
3. `image_filename`
4. 图片文件名兜底

推荐使用完整相对路径，避免不同目录存在同名图片时产生歧义。

常见字段包括：

```json
{
  "rows": [
    {
      "src_rel_path": "目录1/image-001.png",
      "dest_rel_path": "目录1/image-001.png",
      "actual_input_prompt": "a portrait",
      "model_name": "example-model",
      "width": 1024,
      "height": 1024
    }
  ]
}
```

manifest 匹配不到图片不会阻止图片导入，未匹配图片的 prompt 和 catalog 数据为空。

### 11.3 tasks.json

推荐格式：

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "overall-0001",
      "criterion": "overall",
      "images": [
        { "src_rel_path": "目录1/a.png", "role": "target" },
        { "src_rel_path": "目录1/b.png", "role": "filler" }
      ]
    }
  ]
}
```

支持的评分维度：

```text
overall
creativity
mood
composition
color
lighting
realism
detail
promptAlignment
textCorrectness
anatomyNormality
informationClarity
designQuality
typography
```

支持的图片角色：

```text
target
filler
anchor_low
anchor_high
boundary
```

校验规则：

- 每个任务 ID 在当前 ZIP 内唯一。
- 每个任务包含 1 到 5 张图片。
- 同一个任务中图片不能重复。
- 图片引用必须能唯一匹配到 ZIP 中的图片。
- 相同评分维度和相同图片集合不能重复。
- 任务维度必须在支持列表中。

详细格式请参考 `docs/ZIP_TASKS_FORMAT.md` 和 `docs/tasks.example.json`。

### 11.4 XLSX 分配表

管理端会在浏览器端读取 XLSX，然后把解析后的数组发送给后端。

服务端和前端都支持识别以下类型的列名：

打分人列：

```text
打分人、打分人名字、打分账号、账号、用户名、姓名、名字、
name、username、user、scorer
```

数量列：

```text
数量、任务数量、任务数、分配数量、分配任务数、
count、taskcount、tasks、number
```

推荐表格：

| 打分人 | 分配数量 |
| --- | ---: |
| 张三 | 5000 |
| 李四 | 5000 |

## 12. 认证和安全

### 12.1 密码

密码不会以明文保存。服务端使用随机盐和 `crypto.scryptSync` 生成如下格式的哈希：

```text
scrypt$盐值$哈希值
```

密码规则：

- 长度 8 到 100 位。
- 至少包含一个大写字母。
- 至少包含一个小写字母。
- 至少包含一个特殊字符。

### 12.2 登录失败和验证码

当前账号级登录保护规则：

- 账号在 15 分钟窗口内连续失败。
- 第一次密码失败后，后续登录需要图形验证码。
- 图形验证码在账号和密码校验之前验证。
- 验证码错误不会进入账号密码校验流程。
- 验证码错误不会增加账号密码失败次数。
- 账号密码正确但验证码错误时，仍然只返回验证码错误。
- 密码错误且账号存在时才增加账号失败次数。
- 连续失败达到 5 次后锁定账号 10 分钟。
- 登录成功后清除失败次数和锁定状态。
- 首次登录或管理员重置密码后的账号由 `mustChangePassword` 标记强制改密。

`AUTH_CAPTCHA_SECRET` 用于对验证码答案进行 HMAC 哈希。多实例部署时，所有 API 实例必须使用同一个密钥。

### 12.3 IP 处理说明

当前应用不再根据 IP 对多个账号尝试进行锁定。登录记录仍保存请求 IP，主要用于审计和后续排查。

Nginx 仍配置了网络层请求限制：

- 每个会话约 `30r/s`。
- 每个 IP 约 `1500r/s`。

这属于 Nginx 请求速率限制，不等于应用层的账号锁定。

### 12.4 会话

- 会话 Token 使用随机字节生成。
- 数据库只保存 Token 的 SHA-256 哈希。
- 浏览器保存 HttpOnly Cookie。
- 默认会话有效期为 7 天。
- 会话最后访问时间最多每 5 分钟写回一次，避免每个请求都更新数据库。

### 12.5 文件访问

图片通过 `/files/*` 提供，服务端会检查：

- 路径是否为安全的相对路径。
- 路径是否包含合法图片扩展名。
- 是否访问受保护的临时目录。

当前 `/files` 静态资源中间件位于 `/api` 登录中间件之前，因此路径校验不等同于登录鉴权。部署时应将图片 URL 视为可被直接访问的资源；如果图包属于敏感数据，需要进一步增加资源级会话校验或签名 URL。

## 13. 分页、缓存和性能设计

### 13.1 分页

当前接口同时支持两种分页方式：

- 页码分页：`page` + `pageSize`。
- 游标分页：`cursor`。

游标分页适合大数据量任务列表，避免深页 `OFFSET` 越来越慢。游标通常包含：

```json
{
  "taskType": "dimension:overall",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "id": "task-id",
  "criterionOrder": 0
}
```

任务列表通过多列排序确保游标稳定：

```text
评分维度顺序、createdAt、id
```

### 13.2 总数统计

以下情况会执行总数统计：

- 页面需要显示准确页数。
- 请求显式传入 `includeTotal=1`。
- 项目统计页使用预计算的 `project_task_stats`。
- 打分端仪表统计使用 `scorer_task_stats`。

如果只需要快速加载下一页，优先使用 `hasMore` 和 `nextCursor`，不要求每次查询 `COUNT(*)`。

### 13.3 服务端缓存

当前主要缓存：

| 数据 | 缓存时间 |
| --- | ---: |
| 管理仪表盘统计 | 15 秒 |
| 项目汇总 | 15 秒 |
| 仪表盘进度 | 15 秒 |
| 打分管理汇总 | 15 秒 |
| 打分端统计 | 2 秒 |
| 打分任务列表 | 1 秒 |
| HTTP 短缓存响应头 | 2 秒 |

任务写入、评分提交、任务回退和项目变更后会主动清理相关缓存。

### 13.4 前端请求优化

`client/src/services/http.ts` 提供：

- 相同 URL 的并发 GET 请求合并。
- 查询过载、查询超时和连接池排队超时的 GET 重试。
- 401 时统一清除当前用户并跳转登录页。

导入状态和导出状态轮询间隔均为 10 秒。

### 13.5 数据库连接和超时

默认配置：

```text
PG_POOL_MAX=24
PG_STATEMENT_TIMEOUT_MS=60000
PG_LOCK_TIMEOUT_MS=2000
```

连接池配置不应脱离 SQL 优化单独增加。多人同时打分时，应优先检查：

- 是否仍然执行不必要的 `COUNT(*)`。
- 是否使用了正确的索引。
- 是否使用游标代替深分页。
- 是否存在大图请求占满 Web 连接。
- 是否有长事务或批量事务阻塞评分写入。

## 14. 导出设计

异步导出代码主要位于：

- `server/src/app.js`
- `server/src/services/admin-dashboard.js`
- `client/src/services/images.ts`

导出流程：

1. 前端提交导出类型和筛选条件。
2. 服务端创建导出作业并返回 `202`。
3. 作业进入进程内队列。
4. 默认一次只执行一个导出作业。
5. 服务端分页读取任务。
6. JSON 导出按批次写入文件流，不把全部结果一次性拼到内存。
7. 前端每 10 秒查询导出状态。
8. 作业完成后返回下载地址。
9. 导出文件保留 24 小时，之后自动清理。

支持的异步导出类型：

```text
project-completed-tasks
scorer-completed-tasks
team-task-summary
project-task-report
```

导出文件名包含导出对象、导出类型和时间戳。例如：

```text
张三-完成任务明细-2026-09-09T10-20-30-000Z.json
```

多项目、多打分人或多团队导出时，服务端按业务类型组织数据，前端按照每个对象依次触发下载。

当前导出作业保存在 API 进程内存中，导出过程中如果 API 重启，作业状态和临时导出文件不会自动恢复。

## 15. 部署和运行

### 15.1 Docker Compose 启动

首次启动：

```bash
cp -n .env.example .env
# 编辑 .env，至少修改 POSTGRES_PASSWORD
docker compose up --build -d
```

查看服务：

```bash
docker compose ps
docker compose logs --tail=100 api
docker compose logs --tail=100 web
```

默认访问：

```text
http://服务器IP:8080
```

### 15.2 本地开发

安装依赖：

```bash
npm run install:all
```

启动前端和后端：

```bash
npm run dev
```

开发地址：

- 前端 Vite：通常为 `http://127.0.0.1:5173`
- 后端 API：`http://127.0.0.1:3000`

Vite 会将 `/api` 和 `/files` 代理到本地后端。

单独启动：

```bash
npm --prefix server run dev
npm --prefix client run dev
```

前端检查和构建：

```bash
npm --prefix client run typecheck
npm --prefix client run build
```

### 15.3 环境变量

| 变量 | 作用 | 默认或示例 |
| --- | --- | --- |
| `POSTGRES_DB` | 数据库名 | `image_rating` |
| `POSTGRES_USER` | 数据库用户 | `image_rating` |
| `POSTGRES_PASSWORD` | 数据库密码 | 必填 |
| `DATABASE_URL` | API 数据库连接串 | PostgreSQL URL |
| `WEB_PORT` | Web 对外端口 | `8080` |
| `PORT` | API 容器端口 | `3000` |
| `RATING_DATA_DIR` | 图片、inbox 的宿主机根目录 | `/data/sunwenxiu/rating` |
| `POSTGRES_DATA_DIR` | PostgreSQL 数据目录 | `/var/lib/rating/postgres` |
| `UPLOAD_DIR` | API 容器内上传目录 | `/app/uploads` |
| `PG_POOL_MAX` | PostgreSQL 连接池上限 | `24` |
| `PG_STATEMENT_TIMEOUT_MS` | SQL 执行超时 | `60000` |
| `PG_LOCK_TIMEOUT_MS` | 数据库锁等待超时 | `2000` |
| `TASK_WRITE_BATCH_SIZE` | 任务创建批量大小 | `1000` |
| `TASK_ASSIGN_BATCH_SIZE` | 任务分配批量大小 | `1000` |
| `IMAGE_IMPORT_CONCURRENCY` | 图片处理并发数 | `4` |
| `IMPORT_DB_BATCH_SIZE` | 图片和模板写入批量大小 | `1000` |
| `IMPORT_DB_ITEM_BATCH_SIZE` | 模板图片写入批量大小 | `5000` |
| `IMAGE_THUMBNAIL_SIZE` | 缩略图最大边 | `640` |
| `IMAGE_THUMBNAIL_QUALITY` | WebP 质量 | `76` |
| `AUTH_CAPTCHA_SECRET` | 验证码 HMAC 密钥 | 至少 32 位随机字符串 |
| `TRUST_PROXY` | 反向代理层数 | 例如 `1` |
| `COOKIE_SECURE` | 是否只通过 HTTPS 发送 Cookie | `false` |
| `CORS_ORIGIN` | 跨域来源 | 空表示不启用跨域来源 |

### 15.4 持久化目录

```text
${RATING_DATA_DIR}/
├─ uploads/
│  ├─ 图包图片和缩略图
│  ├─ _zips/
│  ├─ _chunks/
│  ├─ _resumable/
│  ├─ _pending-json/
│  ├─ _exports/
│  └─ feedback/
├─ inbox/
│  └─ SFTP 导入文件
└─ inbox/processed/
   └─ 已完成本地导入的 ZIP
```

PostgreSQL 数据目录由 `POSTGRES_DATA_DIR` 挂载到数据库容器。

不要在没有备份的情况下删除：

- PostgreSQL 数据目录。
- `uploads` 目录。
- `_pending-json` 目录中仍在等待补充 JSON 的文件。

## 16. 数据备份和恢复

### 16.1 数据库备份

```bash
mkdir -p backups
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > backups/postgres_$(date +%Y%m%d_%H%M%S).sql
```

### 16.2 图片备份

```bash
tar czf backups/image_uploads_$(date +%Y%m%d_%H%M%S).tgz \
  -C "$RATING_DATA_DIR/uploads" .
```

### 16.3 恢复

恢复前停止 API 和 Web：

```bash
docker compose down
docker compose up -d postgres
```

恢复数据库：

```bash
cat backups/your_backup.sql | docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

恢复图片：

```bash
tar xzf backups/your_uploads_backup.tgz \
  -C "$RATING_DATA_DIR/uploads"
```

恢复完成后：

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=100 api
```

恢复后应验证：

1. 管理员登录。
2. 图包列表和图片访问。
3. 项目列表。
4. 任务列表和任务统计。
5. 打分提交。
6. 导出任务。

## 17. SQLite 迁移到 PostgreSQL

迁移脚本：`server/src/migrate-sqlite-to-postgres.js`

迁移前：

1. 停止 API 写入。
2. 备份 SQLite 文件。
3. 备份上传图片目录。
4. 确认 PostgreSQL 已启动并可连接。

迁移命令示例：

```bash
docker compose run --rm \
  -v /path/to/image-rating.sqlite:/migration/image-rating.sqlite:ro \
  -e SQLITE_PATH=/migration/image-rating.sqlite \
  api npm run migrate:sqlite
```

脚本会：

- 创建或更新 PostgreSQL schema。
- 按外键依赖顺序迁移数据。
- 将时间字段转换为 `timestamptz`。
- 暂时关闭任务统计触发器。
- 迁移任务和任务项。
- 重建项目任务统计和打分人任务统计。
- 执行 `ANALYZE`。
- 发生异常时回滚 PostgreSQL 事务。

迁移完成后应抽查以下表的数据量：

```text
users
subjects
images
projects
project_packages
rating_tasks
rating_task_items
subject_task_templates
subject_task_template_items
project_task_stats
scorer_task_stats
```

## 18. SFTP 导入

服务端把宿主机的 inbox 目录挂载为 `/app/inbox`。

上传时建议使用临时后缀：

```text
example.zip.part
```

上传完成后再改名为：

```text
example.zip
```

执行导入：

```bash
docker compose exec -T api \
  node src/import-local.js /app/inbox/example.zip
```

成功后原始文件移动到：

```text
/data/sunwenxiu/rating/inbox/processed/example.zip
```

保留原始文件：

```bash
docker compose exec -T api \
  node src/import-local.js /app/inbox/example.zip --keep
```

详细说明请参考 `docs/SFTP_IMPORT.md`。

## 19. 常见问题排查

### 19.1 页面返回 502

检查：

```bash
docker compose ps
docker compose logs --tail=200 api
docker compose logs --tail=100 web
```

重点确认：

- API 容器是否启动。
- PostgreSQL healthcheck 是否通过。
- `DATABASE_URL` 是否正确。
- API 是否在容器内监听 `3000`。
- Web 容器是否能解析 `api` 服务名。

### 19.2 返回 `database is locked`

当前生产目标是 PostgreSQL。如果仍然看到 SQLite 风格的锁错误，应检查：

- 实际运行的版本是否仍连接 SQLite。
- 服务器是否启动了旧版本进程。
- `DATABASE_URL` 是否指向正确数据库。
- 是否同时运行多个旧 API 实例。
- 是否存在长事务。

PostgreSQL 常见对应错误包括：

- `57014`：SQL statement timeout。
- `55P03`：锁等待超时。
- 连接池排队超时：连接不足或请求长期占用连接。

### 19.3 登录返回 401

检查：

- 用户名是否正确。
- 密码是否为当前密码。
- 账号是否被禁用。
- 打分人所属团队是否被禁用。
- 是否已经触发图形验证码。
- 验证码是否过期或重复使用。
- 是否达到 5 次失败并被锁定 10 分钟。

管理员修改打分人密码后，打分人下次登录会被要求先修改密码。

### 19.4 登录返回 429

应用层常见原因是账号已达到失败次数上限并进入 10 分钟锁定期。

如果响应来自 Nginx，也可能是 Web 层请求速率限制。应查看：

```bash
docker compose logs --tail=200 web
```

### 19.5 任务生成作业不存在或已过期

检查：

- 页面请求的项目 ID 是否与作业所属项目一致。
- 作业是否已经超过 24 小时保留期。
- API 是否在创建作业后立即重启。
- `task_generation_jobs` 中的 `subjectid` 是否对应 `projects.id`。
- 项目关联图包是否已经导入完成。

服务端重启会将中断的任务生成作业标记为失败，而不会自动从中间批次继续。

### 19.6 任务列表很慢

优先检查：

- 请求是否传了 `includeTotal=1`。
- 是否频繁刷新任务列表。
- 是否使用深页 `OFFSET`。
- 是否同时请求大图原图而不是缩略图。
- `rating_tasks` 相关复合索引是否存在。
- `project_task_stats` 和 `scorer_task_stats` 是否最新。
- PostgreSQL 是否存在长事务或锁等待。

打分端列表默认只取 5 条，列表图片使用缩略图，完成后统计优先在前端本地更新。

### 19.7 上传 HEAD 返回 404

可能原因：

- 浏览器 localStorage 中保存的是已经过期的上传会话。
- API 容器重启后临时上传目录被清理。
- 上传 ID 不属于当前服务器实例。
- 上传会话已完成并进入导入处理。

前端会将 404 视为会话不存在，并重新创建上传会话。如果原始上传已经生成导入作业，前端会继续查询对应作业状态。

### 19.8 上传成功但图片打不开

检查：

```bash
docker compose logs --tail=200 api
ls -lah "$RATING_DATA_DIR/uploads"
```

确认：

- `RATING_DATA_DIR/uploads` 挂载正确。
- 图片文件确实写入宿主机目录。
- `thumbnailPath` 对应文件存在。
- Web 容器可以访问 API 容器。
- 图片路径没有被清理为非法相对路径。

### 19.9 导出一直等待

检查：

- 是否有其他导出作业占用默认的单并发队列。
- PostgreSQL 查询是否超时。
- `uploads/_exports` 是否有足够空间。
- API 是否发生重启。
- 导出作业是否已经超过 24 小时。

## 20. 当前限制和维护注意事项

### 20.1 进程内作业状态

以下状态主要保存在 API 进程内存中：

- 管理端导出作业。
- 管理端任务回退作业。
- 部分上传作业的运行时对象。

API 重启后：

- 导出作业不会自动恢复。
- 回退作业不会自动恢复。
- 持久化的导入作业和任务生成作业可以通过数据库状态恢复或标记失败。

如果需要多实例部署或高可靠作业系统，应将导出和回退迁移到持久化作业表或独立队列。

### 20.2 任务版本是代码常量

当前服务端在 `server/src/app.js` 中使用：

```js
const taskVersion = "v3";
```

切换任务版本需要同步考虑：

- 任务查询。
- 任务统计。
- 导出筛选。
- 项目状态。
- 任务 ID 生成。
- 已有历史任务数据。

不能只修改前端显示名称而不处理数据库中的 `taskVersion`。

### 20.3 图包不自动生成随机任务

当前任务生成依赖 `subject_task_templates`。模板主要来自 `tasks.json`。如果图包没有有效的 `tasks.json`，导入可以成功，但项目可生成任务数量可能为 0。

在生产导入前应确认：

- `tasks.json` 已放在 ZIP 根目录。
- 每个任务图片引用都能匹配。
- 评分维度名称正确。
- 任务数量符合预期。

### 20.4 事务边界

大批量任务操作必须保持以下原则：

- 事务开始前完成输入校验和候选任务读取。
- 事务内只执行必要的批量写入。
- 批次结束后及时提交。
- 不在事务内进行图片解压、缩略图生成或大文件读写。
- 使用 `SET LOCAL app.skip_rating_task_stats = 'on'` 时，必须在提交前重建统计。

### 20.5 统计表一致性

`project_task_stats` 和 `scorer_task_stats` 是性能优化用的反范式统计表。它们不是任务事实表，任务事实仍以 `rating_tasks` 为准。

如果怀疑统计不一致，可以按项目执行统计重建逻辑，或者重新运行迁移脚本中的统计重建部分。生产环境执行前应先备份数据库。

### 20.6 没有独立测试套件

当前工程的 `package.json` 没有配置自动化测试脚本，也没有独立的 `tests` 目录。修改共享任务、认证、导入和统计逻辑后，至少应执行：

```bash
npm --prefix client run typecheck
npm --prefix client run build
```

并进行手工回归：

1. 管理员登录。
2. 打分人登录和首次改密。
3. 图包上传。
4. JSON 补充处理。
5. 创建项目。
6. 少量任务生成。
7. 多维度任务分配。
8. 打分提交和下一条任务。
9. 项目删除。
10. 导出和反馈。

## 21. 推荐开发和发布流程

### 开发

1. 修改前先检查 `git status`，保留用户已有改动。
2. 先阅读相关服务、页面、类型和 schema。
3. 修改后执行前端类型检查。
4. 修改任务或数据库逻辑时补做小数据量手工验证。
5. 对批量任务操作检查事务、回滚和统计重建。

### 发布

```bash
git diff --check
npm --prefix client run build
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 api
```

如使用发布压缩包：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\package-release.ps1
```

发布前必须确认压缩包中没有不应外发的数据库密码、验证码密钥和其他环境机密。`.env` 只应在受控部署环境中使用，不应提交到公共仓库。

## 22. 相关文档索引

| 文档 | 内容 |
| --- | --- |
| `README.md` | 快速启动和最短使用流程 |
| `DEPLOY.md` | Docker 部署、备份、恢复、迁移和 HTTPS 代理 |
| `docs/ZIP_TASKS_FORMAT.md` | ZIP 和 `tasks.json` 格式 |
| `docs/tasks.example.json` | 任务 JSON 示例 |
| `docs/SFTP_IMPORT.md` | SFTP 上传和服务器本地导入 |
| `server/src/postgres-schema.sql` | PostgreSQL 表、索引和触发器定义 |
| `server/src/app.js` | API 路由和核心业务实现 |
| `server/src/services/admin-dashboard.js` | 仪表盘统计和导出实现 |
| `client/src/services/images.ts` | 前端上传、任务、导出和图片 API |
