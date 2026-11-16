# V4 全量已完成任务分片包：格式说明与内容解释

对象文件：`V4_ALL_COMPLETED_slices_7x7_20261106.tar`（730,340,864 字节，约 696.5 MiB）

本文基于仓库内实际代码（任务表结构、导出 SQL、切片脚本）和对包内数据的全量核验写成。除特别标注“抽样”外，文中数字均为对包内 20 个切片的逐条统计结果。

---

## 0. 一句话结论

这个 tar 不是图片包，而是**评分平台导出的“已完成打分任务”元数据**：按「评分维度 × 图源对类型」切成 20 个 gzip JSON 文件，外加一个 `manifest.json`。共 **920,503 条任务**，每条任务固定是**两张图的一次成对比较**（谁更好 / 是否同档 / 某张不适用 / 是否正确），包含打分人、时间、排序结果等，但**不包含图片文件本身，也不包含任何绝对分数**。

关键数字：

| 指标 | 值 |
|---|---:|
| 任务总数 | 920,503 |
| 回测任务（`isBacktest=true`） | 45,933（4.99%） |
| 分片数 | 20（7 维度 × 7 图源对 = 49 种组合中的非空组合） |
| 项目数（`subjectName` 去重） | 27 |
| 图源对类型 | 7 种（GT_GT / GT_GEN / GT_ROLL / ROLL_ROLL / GEN_GEN / GEN_ROLL / UNKNOWN） |
| 打分维度 | 7 种（anatomyNormality / realism / color / creativity / saturation / highInfoAes / lighting） |
| 完成时间范围 | 2026-10-29T23:07:03.504Z ～ 2026-11-06T05:01:55.414Z |
| 截止时间（快照点） | 2026-11-06T05:01:55.529Z |
| 导出时间 | 2026-11-06T05:06:41.710Z |

---

## 1. 数据从哪里来（代码链路）

### 1.1 数据库里的“任务表”

核心是 `rating_tasks`（`server/src/postgres-schema.sql:270`），一行 = 一个任务：

- `id`：任务 id。基础任务由 `sha256(projectId|taskVersion|taskType|排序后的imageIds)` 生成（`server/src/app.js` 的 `deterministicTaskId`）；回测任务是随机 UUID。
- `subjectId`：图包 id（`subjects.id`），不是项目 id。
- `projectId`：项目 id（`projects.id`）。一个项目可以通过 `project_packages` 关联多个图包，所以 `subjectId` 与 `projectId` 是多对多，不能互相替代。
- `taskVersion`：本批全部为 `v3`（服务端常量，`server/src/app.js:1217`）。
- `taskType`：任务类型字符串，语法见 §4.2。
- `status`：`pending / assigned / completed`，本批只导出 `completed`。
- `scorer`、`startedAt`、`completedAt`、`durationMs`：打分人与耗时。
- `ranking`、`rankingRelations`、`excludedImageIds`、`correctImageIds`：打分结果（JSON 文本列）。
- `submissionMode`、`rankingActionCount`、`dragActionCount`、`orderChanged`、`largeImageOpened`、`largeImageOpenCount`、`firstActionMs`、`pageBlurCount`、`behaviorTracked`、`riskScore`、`riskFlags`：行为/风控埋点。
- `isBacktest`、`backtestSourceId`：回测标记与原任务引用。
- `imageKey`：排序后的图片 id 用 `|` 拼接，和 `id` 一起保证任务唯一性。

任务与图片的关联在 `rating_task_items`（`server/src/postgres-schema.sql:357`）：

- `taskId + imageId` 主键，`position` 为展示顺序，`role` 为角色（`target / filler / anchor_low / anchor_high / boundary`）。
- 图片元数据在 `images` 表（`server/src/postgres-schema.sql:212`）：`originalPath`（图包内相对路径，分类依据）、`storagePath`（文件服务相对路径）、`thumbnailPath`、`prompt`、`category` 等。

### 1.2 导出与切片脚本

1. `operations/v4-export-all-completed.mjs`
   - 以 `V4_IMAGES_01.createdAt` 为锚点，取出该时间之后创建、未删除的所有项目；
   - 运行时给 `admin-dashboard.js` 打补丁，注入 `completedFrom/completedTo` 过滤（因此源文件头部的 `filters.completedTo` 是脚本为“时间快照”注入的，常规接口默认只有 `projectIds`）；
   - 调用 `writeProjectCompletedTasksExport`（`server/src/services/admin-dashboard.js:1193`）→ `writeCompletedTasksExport`（`:1141`）流式写出 `{"exportedAt":...,"tasks":[...]}` 的单个 gzip 文件。
   - 任务行由 `listCompletedTaskRowsAfter`（`:240`）按 `id` 升序游标分页读取，再由 `hydrateTaskRows`（`server/src/app.js:6949`）补上 `items[]` 与图片信息。
2. `operations/v4-slice-completed-export.mjs`
   - 逐条读取上面的源文件，按 `task.criterion`（维度）和 `classifyTask(task)`（图源对）写入 20 个分片；
   - 分片命名 `<dimension>__<sourceType>.json.gz`；
   - 同时生成 `manifest.json`，包含每个分片的条数、压缩大小、sha256，以及分类规则、各规则命中数等。
3. 打包
   - tar 只是把输出目录整体归档，**没有额外的校验文件或索引**；完整性以 `manifest.json` 里的 sha256 为准。

### 1.3 与本地源文件的对应关系

- `manifest.json` 的 `sourceFile` 为 `V4_ALL_COMPLETED_2026-11-06T05-01-55-529Z.json.gz`；
- `sourceSha256` 为 `24785aa865731cd796087d6cb934ee5aebdc44956414d8e68c3b81e449771d30`；
- 该值与本地 `V4_全部已完成任务_截至20261106-130155.json.gz` 的 sha256 **完全一致**（已实测），即同一份文件，只是重命名过（13:01:55 为北京时间，对应 UTC 05:01:55）。

---

## 2. 归档结构

```
V4_ALL_COMPLETED_slices_2026-11-06T05-01-55-529Z/
├── manifest.json
├── anatomyNormality__GEN_GEN.json.gz
├── anatomyNormality__GEN_ROLL.json.gz
├── anatomyNormality__ROLL_ROLL.json.gz
├── color__GEN_GEN.json.gz
├── color__GT_GT.json.gz
├── creativity__GEN_GEN.json.gz
├── creativity__GEN_ROLL.json.gz
├── creativity__GT_GEN.json.gz
├── creativity__GT_GT.json.gz
├── creativity__GT_ROLL.json.gz
├── highInfoAes__GT_ROLL.json.gz
├── lighting__GEN_GEN.json.gz
├── lighting__GT_GT.json.gz
├── lighting__GT_ROLL.json.gz
├── realism__GEN_GEN.json.gz
├── realism__GT_GT.json.gz
├── realism__GT_ROLL.json.gz
├── saturation__GEN_GEN.json.gz
├── saturation__GT_GEN.json.gz
└── saturation__UNKNOWN.json.gz
```

- 目录名 = 源文件时间戳 `2026-11-06T05-01-55-529Z`（即 `filters.completedTo`）。
- 20 个分片 + 1 个 manifest = 21 个文件；`tar -tf` 会多出一个目录条目，共 22 行。
- 每个 `.json.gz` 解压后是**一个完整 JSON 对象**（不是 JSONL，也没有换行分隔）。
- 未压缩总量约 3.43 GiB；压缩比约 5:1。

---

## 3. `manifest.json` 字段说明

| 字段 | 类型 | 含义 |
|---|---|---|
| `generatedAt` | ISO 时间 | 切片生成时间（2026-11-06T06:43:11.518Z） |
| `classificationVersion` | string | 图源对分类规则版本，本包为 `v4-source-pair-v1` |
| `sourceFile` | string | 源文件名（`V4_ALL_COMPLETED_2026-11-06T05-01-55-529Z.json.gz`） |
| `sourceSha256` | string | 源文件 sha256，可用于确认分片来源 |
| `taskCount` | int | 任务总数（920,503），等于各分片 `taskCount` 之和（已核验） |
| `backtestCount` | int | `isBacktest=true` 的任务数（45,933） |
| `dimensionCount` | int | 维度数（7） |
| `sourceTypeCount` | int | 图源对类型数（7） |
| `nonEmptySliceCount` | int | 非空分片数（20） |
| `countsByRule` | object | 分类规则命中数：`image_path` / `project_fallback` / `unresolved` |
| `unknownByProject` | object | `UNKNOWN` 任务按项目名的分布 |
| `sourceTypes` | string[] | 7 种图源对类型（固定顺序） |
| `dimensions` | string[] | 7 个维度（固定顺序） |
| `projectFallback` | object | 项目名 → 图源对的兜底映射（见 §3.2） |
| `pathRules` | object | 路径关键词规则（GT / GEN / ROLL 各自的 token 列表） |
| `slices` | array | 每个分片的元数据，见下表 |

`slices[]` 元素：

| 字段 | 含义 |
|---|---|
| `dimension` | 评分维度 |
| `sourceType` | 图源对类型 |
| `taskCount` | 分片内任务数 |
| `filename` | 分片文件名 |
| `compressedBytes` | 压缩后字节数 |
| `sha256` | 分片内容 sha256（可直接校验） |

### 3.1 图源对类型（sourceType）的含义

分类只回答“这两张图分别来自哪种来源”，不评价质量：

| 标签 | 含义 | 路径识别关键词（`pathRules`） |
|---|---|---|
| `GT` | 原始图/参考图（ground truth） | `source_images_part`、`s3_source_images`、`original`、`gt` |
| `GEN` | 生成模型产出 | `cci_images`、`u15_sft`、`u16_mt`、`qwen-image`、`ideogram`、`mj`、`gpt-image`、`seed` |
| `ROLL` | rollout / 修复 / 改进图 | `rollout`、`repaired`、`improved` |

- `GT_GT`：两张都是原始图（例如同一 prompt 的两张参考图比较）。
- `GT_GEN`：原始图 vs 生成图。
- `GT_ROLL`：原始图 vs rollout/修复图。
- `GEN_GEN`：两张生成图（可能来自同一或不同模型）。
- `GEN_ROLL`：生成图 vs rollout/修复图。
- `ROLL_ROLL`：两张 rollout/修复图。
- `UNKNOWN`：路径无法识别且项目名不在兜底表里。

### 3.2 分类算法（`classifyTask`）

```
取 items[0].image.originalPath 和 items[1].image.originalPath
  ├─ 两者都能识别为 GT/GEN/ROLL → 按 GT < GEN < ROLL 排序拼成 key
  │    （例如 GEN + ROLL → GEN_ROLL；顺序不影响结果）
  └─ 否则 → 查 projectFallback[task.subjectName]（subjectName 实际是项目名）
       ├─ 命中 → 使用映射值（rule=project_fallback）
       └─ 未命中 → UNKNOWN（rule=unresolved）
```

`projectFallback` 内容（本包 manifest 原样）：

| 项目名 | 兜底类型 |
|---|---|
| V4_GT_RE_1.6 | GT_GEN |
| V4_UG_1.6 | GEN_ROLL |
| V4_CREATIVITY_1.6 | GT_GT |
| V4_COLORS_1.6 | GT_GT |
| V4_REALISM_1104 | GT_GT |
| V4_LIGHTING_1104 | GT_GT |
| V4_INFO_CREATIVITY_GT_1104 | GT_GT |
| V4_LIGHTING_GT_1104 | GT_GT |
| V4_HUMANREFINER_VS_REPAIRED_1104 | GEN_ROLL |
| V4_ROLLOUT_VS_REPAIRED_1104 | ROLL_ROLL |
| V4_INFO_CREATIVITY_ORIGINAL_VS_ROLLOUT_1104 | GT_ROLL |
| V4_INFO_REALISM_ORIGINAL_VS_ROLLOUT_1104 | GT_ROLL |
| V4_INFO_LIGHTING_ORIGINAL_VS_ROLLOUT_1104 | GT_ROLL |

本包命中情况：

| 规则 | 数量 | 占比 |
|---|---:|---:|
| `image_path` | 585,471 | 63.60% |
| `project_fallback` | 282,092 | 30.65% |
| `unresolved`（UNKNOWN） | 52,940 | 5.75% |

> 注意：这是**基于路径字符串的启发式分类**，不是模型血缘的强保证。项目名兜底只覆盖上表 13 个项目，其余项目一旦路径没命中关键词就会落到 `UNKNOWN`。本包的 52,940 条 UNKNOWN 全部来自 `V4_IMAGES_01`（29,236 条）和 `V4_IMAGES_02`（23,704 条），原因见 §6.6。

---

## 4. 分片 JSON 格式

### 4.1 顶层结构

```json
{
  "classificationVersion": "v4-source-pair-v1",
  "dimension": "anatomyNormality",
  "sourceType": "GEN_ROLL",
  "sourceFile": "V4_ALL_COMPLETED_2026-11-06T05-01-55-529Z.json.gz",
  "tasks": [ { ... }, { ... } ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `classificationVersion` | string | 与 manifest 相同 |
| `dimension` | enum | 该分片的评分维度；分片内每条任务的 `criterion` 都等于它（已全量核验） |
| `sourceType` | enum | 该分片的图源对类型；与按 §3.2 规则对每条任务重新分类的结果完全一致（已全量核验） |
| `sourceFile` | string | 源文件名，便于追溯 |
| `tasks` | array | 任务数组；分片内按 `id` 升序（导出 SQL `ORDER BY id`） |

### 4.2 `task` 对象

一条任务 = 一次成对比较。字段如下（`来源` 指数据库列或派生方式）：

**标识与归属**

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `id` | string | `rating_tasks.id` | 基础任务为 64 位 sha256；回测任务为 UUID |
| `subjectId` | string | `rating_tasks.subjectId` | 图包 id（`subjects.id`），不是项目 id |
| `projectId` | string | `rating_tasks.projectId` | 项目 id（`projects.id`） |
| `subjectName` | string | `projects.name` | **项目名**（字段名容易误解为图包名） |
| `taskVersion` | string | `rating_tasks.taskVersion` | 本批均为 `v3` |
| `taskType` | string | `rating_tasks.taskType` | 语法见下 |
| `criterion` | string | `taskType.split(":")[1]` | 评分维度，如 `anatomyNormality` |
| `status` | string | `rating_tasks.status` | 本批全部为 `completed` |

`taskType` 语法：

```
dimension:<criterion>[:project:<projectId>][:backtest:<backtestTaskId>]
```

- 本批所有任务都带 `:project:<projectId>` 段（已全量核验）；
- 回测任务在末尾再追加 `:backtest:<uuid>`，且该 uuid 等于任务 `id`；
- 旧项目（`projectId == packageId`）理论上会省略 `:project:` 段，但本批没有这种任务。

**打分人与时间**

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `scorer` | string | `rating_tasks.scorer` | 打分人用户名（中文姓名） |
| `startedAt` | ISO/null | `rating_tasks.startedAt` | 开始时间 |
| `completedAt` | ISO/null | `rating_tasks.completedAt` | 完成时间；本批全部非空，且都不晚于快照点 |
| `durationMs` | int/null | `rating_tasks.durationMs` | 从打开任务到提交的毫秒数（可能很大，含挂机时间） |

**排序结果（核心标签）**

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `ranking` | string[] | `rating_tasks.ranking` | **从优到劣**的 `imageId` 数组；被排除的图不出现在这里；长度 = 图数 − 排除数；可为空数组 |
| `rankingRelations` | (`">"`\|`"="`)[] / null | `rating_tasks.rankingRelations` | 长度 = `ranking.length − 1`；`">"` 表示前者优于后者，`"="` 表示同档 |
| `excludedImageIds` | string[] | `rating_tasks.excludedImageIds` | 被标记“不符合该维度 / 无需打分”的图；不参与排序 |
| `correctImageIds` | string[] | `rating_tasks.correctImageIds` | 仅 `textCorrectness` / `anatomyNormality` 使用：被确认“正确/正常”的图；未点选的默认“不正确” |

**提交行为**

| 字段 | 类型 | 来源 | 本批有效性 |
|---|---|---|---|
| `submissionMode` | `direct`/`ranked`/null | `rating_tasks.submissionMode` | 有效。`ranked` = 提交前发生过排序操作；`direct` = 直接接受默认顺序提交 |
| `rankingActionCount` | int | 同名列 | 有效，排序操作次数 |
| `largeImageOpened` | bool | 同名列 | 有效 |
| `dragActionCount` | int | 同名列 | **无效，恒 0**（导出 SQL 未 SELECT） |
| `orderChanged` | bool | 同名列 | **无效，恒 false**（未 SELECT） |
| `largeImageOpenCount` | int | 同名列 | **无效，恒 0**（未 SELECT） |
| `firstActionMs` | int/null | 同名列 | **无效，恒 null**（未 SELECT） |
| `pageBlurCount` | int | 同名列 | **无效，恒 0**（未 SELECT） |
| `behaviorTracked` | bool | 同名列 | **无效，恒 false**（未 SELECT） |
| `riskScore` | int | 同名列 | **无效，恒 0**（未 SELECT） |
| `riskFlags` | string[] | 同名列 | **无效，恒 []**（未 SELECT） |

> 这一点很重要：`listCompletedTaskRowsAfter`（`server/src/services/admin-dashboard.js:244`）的 SELECT 列表里没有上述行为列，`hydrateTaskRows` 只能填默认值。因此**这份导出不能用于行为/风控分析**，只能用 `submissionMode`、`rankingActionCount`、`largeImageOpened` 这三个真实字段。已实测：GEN_ROLL 全量 24,477 条中 `behaviorTracked/riskScore/dragActionCount/orderChanged/pageBlurCount/firstActionMs/largeImageOpenCount` 全部为 0/false/null。

**编辑与回退**

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `editedAt` | ISO/null | 同名列 | 最近一次修改完成结果的时间 |
| `editCount` | int | 同名列 | 修改次数 |
| `claimToken` | null | — | 管理员导出时强制为 `null`（`includeAdminFields: true`） |
| `rollbackCount` | int | 同名列 | 被回退次数 |
| `lastRolledBackAt` | ISO/null | 同名列 | 最近回退时间 |
| `lastRolledBackBy` | string/null | 同名列 | 最近回退操作人 |

**回测与其它**

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `isBacktest` | bool | `rating_tasks.isBacktest` | 是否为回测任务 |
| `backtestSourceTaskId` | string/null | `rating_tasks.backtestSourceId` | 回测任务对应的原任务 id；非回测为 null |
| `imageKey` | string | `rating_tasks.imageKey` | 排序后的 `imageId` 以 `|` 连接；与 `id` 一起唯一标识任务 |
| `createdAt` | ISO | `rating_tasks.createdAt` | 任务创建时间（发现 2 条异常，见 §8） |
| `updatedAt` | ISO | `rating_tasks.updatedAt` | 最后更新时间 |
| `items` | array | `rating_task_items` + `images` | 任务内图片，本批恒为 2 个 |

### 4.3 `items[]` 与 `image`

```json
"items": [
  {
    "imageId": "89a261a6-e8dc-4b21-9171-a67f0e20d030",
    "position": 0,
    "role": "filler",
    "image": {
      "_id": "89a261a6-e8dc-4b21-9171-a67f0e20d030",
      "subjectId": "f83ebe21-2662-4fcc-a0d1-e7b1611cb019",
      "originalPath": "part_001/images/0e0fbc8fbfcac48ee8881d0e.jpg",
      "category": "未分类",
      "directory": "",
      "isInfographic": false,
      "prompt": null,
      "imageUrl": "/files/humanrefiner_vs_repaired_part_01/part_001/images/89a261a6-e8dc-4b21-9171-a67f0e20d030.jpg",
      "thumbnailUrl": null
    }
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `imageId` | string | 图片 id，与 `image._id` 相同；`ranking` 里用的就是这个值 |
| `position` | int | 任务内展示顺序，0 起 |
| `role` | enum | `target` / `filler` / `anchor_low` / `anchor_high` / `boundary`；本批只出现 `target` 和 `filler` |
| `image._id` | string | `images.id` |
| `image.subjectId` | string | 所属图包 id，等于任务的 `subjectId` |
| `image.originalPath` | string | 图包内原始相对路径；**图源对分类就是看这个字段** |
| `image.category` | string | 图片类目；本批全部为 `未分类` |
| `image.directory` | string | 目录名；本批全部为空串 |
| `image.isInfographic` | bool | 是否信息图 |
| `image.prompt` | string/null | 生成提示词；不同图包覆盖率差异很大（有的 100% 为 null） |
| `image.imageUrl` | string/null | `/files/<storagePath>`，**相对路径**，需拼接部署域名或映射到 uploads 目录 |
| `image.thumbnailUrl` | string/null | `/files/<thumbnailPath>`；为 null 时前端回退到 `imageUrl` |

**为什么没有 `filename`？**
`images` 表有 `filename` 列，后端 `taskImageDto` 也会输出它，但本包实际没有。原因是 `server/src/postgres.js` 的 `mapRow` 会按 camelCase 名称表把结果列改名：`app.js` 里出现的 `rawEntry.fileName` 让 `filename → fileName`，而 `taskImageDto` 只读 `row.filename`，于是该字段变成 `undefined` 被 JSON 序列化丢弃。使用时请以 `_id`、`originalPath`、`imageUrl` 为准，不要依赖 `filename`。

**没有绝对分数**
`images` 表上的 `overall / creativity / color / ...` 等人工分数字段不在本导出里，图片对象也刻意没有 `score`。本包提供的是**相对排序标签**，不是 1–10 的绝对分。

---

## 5. 维度 × 图源对 矩阵

7 个维度 × 7 种图源对共 49 种组合，本批只有 20 种非空：

| 维度 \ 图源对 | GT_GT | GT_GEN | GT_ROLL | ROLL_ROLL | GEN_GEN | GEN_ROLL | UNKNOWN | 合计 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anatomyNormality | — | — | — | 27,455 | 56,779 | 24,477 | — | 108,711 |
| realism | 10,012 | — | 22,110 | — | 72,465 | — | — | 104,587 |
| color | 31,560 | — | — | — | 42,000 | — | — | 73,560 |
| creativity | 100,461 | 24,673 | 47,498 | — | 59,263 | 50,796 | — | 282,691 |
| saturation | — | 97,984 | — | — | 50,075 | — | 52,940 | 200,999 |
| highInfoAes | — | — | 50,000 | — | — | — | — | 50,000 |
| lighting | 33,466 | — | 25,041 | — | 41,448 | — | — | 99,955 |
| **合计** | **175,499** | **122,657** | **144,649** | **27,455** | **322,030** | **75,273** | **52,940** | **920,503** |

分片明细（每条对应一个文件）：

| dimension | sourceType | taskCount | 压缩大小 | 对应项目（抽样观察） |
|---|---|---:|---:|---|
| anatomyNormality | GEN_GEN | 56,779 | 40.3 MiB | V4_ANATOMY_1104 + V4_HUAMAN_1.6 |
| anatomyNormality | GEN_ROLL | 24,477 | 5.6 MiB | V4_HUMANREFINER_VS_REPAIRED_1104 |
| anatomyNormality | ROLL_ROLL | 27,455 | 6.3 MiB | V4_ROLLOUT_VS_REPAIRED_1104 |
| color | GEN_GEN | 42,000 | 30.0 MiB | V4_REAL_1.6 |
| color | GT_GT | 31,560 | 34.2 MiB | V4_COLORS_1.6 |
| creativity | GEN_GEN | 59,263 | 55.2 MiB | V4_CREATIVITY_HIGH_INDEPENDENT_1104 + V4_CREATIVE_1.6 |
| creativity | GEN_ROLL | 50,796 | 10.8 MiB | V4_UG_1.6 |
| creativity | GT_GEN | 24,673 | 5.1 MiB | V4_GT_RE_1.6 |
| creativity | GT_GT | 100,461 | 66.7 MiB | V4_CREATIVITY_1.6 + V4_CREATIVE_1.6 + V4_INFO_CREATIVITY_GT_1104 |
| creativity | GT_ROLL | 47,498 | 49.0 MiB | V4_INFO_CREATIVITY_ORIGINAL_VS_ROLLOUT_1104 |
| highInfoAes | GT_ROLL | 50,000 | 81.8 MiB | V4_IMAGES_06 |
| lighting | GEN_GEN | 41,448 | 34.6 MiB | V4_LIGHTING_1.6_1104 + V4_LIGHTING_1104 |
| lighting | GT_GT | 33,466 | 15.8 MiB | V4_LIGHTING_1104 + V4_LIGHTING_GT_1104 |
| lighting | GT_ROLL | 25,041 | 17.4 MiB | V4_INFO_LIGHTING_ORIGINAL_VS_ROLLOUT_1104 |
| realism | GEN_GEN | 72,465 | 57.7 MiB | V4_COLOR_1.6 + V4_REALISM_1104 + V4_REAL_1104 |
| realism | GT_GT | 10,012 | 9.3 MiB | V4_REALISM_1104 |
| realism | GT_ROLL | 22,110 | 15.3 MiB | V4_INFO_REALISM_ORIGINAL_VS_ROLLOUT_1104 |
| saturation | GEN_GEN | 50,075 | 39.7 MiB | V4_IMAGES_01 + V4_IMAGES_02 |
| saturation | GT_GEN | 97,984 | 79.8 MiB | V4_IMAGES_03 + V4_IMAGES_04 + V4_IMAGES_05 |
| saturation | UNKNOWN | 52,940 | 41.9 MiB | V4_IMAGES_01 + V4_IMAGES_02 |

> “对应项目”来自每个分片前 2,000 条的 `subjectName` 抽样，用于理解内容构成，不是精确的交叉表。

### 5.1 维度分布

| 维度 | 任务数 | 占比 | 中文名（前端文案） |
|---|---:|---:|---|
| creativity | 282,691 | 30.71% | 辨识度与创意感 |
| saturation | 200,999 | 21.84% | 饱和度 |
| anatomyNormality | 108,711 | 11.81% | 肢体：正常性 |
| realism | 104,587 | 11.36% | （肖像/摄像）真实感 |
| lighting | 99,955 | 10.86% | 光照/光影 |
| color | 73,560 | 7.99% | 色彩配比 |
| highInfoAes | 50,000 | 5.43% | 高密度信息图美感 |

### 5.2 图源对分布

| sourceType | 任务数 | 占比 |
|---|---:|---:|
| GEN_GEN | 322,030 | 34.98% |
| GT_GT | 175,499 | 19.07% |
| GT_ROLL | 144,649 | 15.71% |
| GT_GEN | 122,657 | 13.32% |
| GEN_ROLL | 75,273 | 8.18% |
| ROLL_ROLL | 27,455 | 2.98% |
| UNKNOWN | 52,940 | 5.75% |

### 5.3 项目分布（27 个项目）

| 项目（subjectName） | 任务数 | 占比 |
|---|---:|---:|
| V4_IMAGES_01 | 63,000 | 6.84% |
| V4_IMAGES_05 | 60,384 | 6.56% |
| V4_UG_1.6 | 50,796 | 5.52% |
| V4_IMAGES_06 | 50,000 | 5.43% |
| V4_INFO_CREATIVITY_GT_1104 | 48,205 | 5.24% |
| V4_INFO_CREATIVITY_ORIGINAL_VS_ROLLOUT_1104 | 47,498 | 5.16% |
| V4_REAL_1.6 | 42,000 | 4.56% |
| V4_CREATIVE_1.6 | 41,627 | 4.52% |
| V4_COLOR_1.6 | 40,719 | 4.42% |
| V4_HUAMAN_1.6 | 40,170 | 4.36% |
| V4_IMAGES_02 | 40,015 | 4.35% |
| V4_CREATIVITY_HIGH_INDEPENDENT_1104 | 38,444 | 4.18% |
| V4_COLORS_1.6 | 31,560 | 3.43% |
| V4_CREATIVITY_1.6 | 31,448 | 3.42% |
| V4_ROLLOUT_VS_REPAIRED_1104 | 27,455 | 2.98% |
| V4_IMAGES_03 | 27,000 | 2.93% |
| V4_LIGHTING_1.6_1104 | 25,943 | 2.82% |
| V4_INFO_LIGHTING_ORIGINAL_VS_ROLLOUT_1104 | 25,041 | 2.72% |
| V4_REALISM_1104 | 25,032 | 2.72% |
| V4_LIGHTING_1104 | 24,883 | 2.70% |
| V4_GT_RE_1.6 | 24,673 | 2.68% |
| V4_HUMANREFINER_VS_REPAIRED_1104 | 24,477 | 2.66% |
| V4_LIGHTING_GT_1104 | 24,088 | 2.62% |
| V4_INFO_REALISM_ORIGINAL_VS_ROLLOUT_1104 | 22,110 | 2.40% |
| V4_REAL_1104 | 16,726 | 1.82% |
| V4_ANATOMY_1104 | 16,609 | 1.80% |
| V4_IMAGES_04 | 10,600 | 1.15% |
| **合计** | **920,503** | **100%** |

（`V4_HUAMAN_1.6` 的拼写与数据中一致，不是笔误。）

---

## 6. 内容解释

### 6.1 一条任务到底在问什么

任务固定是两张图（本批 100% 为 2 图，已验证：每条任务恰有 `position:0` 和 `position:1`），界面要求打分人：

1. **拖动排序**：`ranking[0]` 是更好的那张，`ranking[1]` 是较差的；两张之间的 `rankingRelations[0]` 为 `">"`（前者优于后者）或 `"="`（同档）。
2. **可选排除**：点 `×` 把不符合当前维度的图标记为“不评价”，进入 `excludedImageIds`，不参与排序（例如“没有肢体出现的图”在打肢体正确性时）。
3. **可选确认正确**：仅 `textCorrectness` / `anatomyNormality` 支持，点“正确/正常”的图进入 `correctImageIds`；未点选的默认“不正确/不正常”。
4. 提交时记录 `submissionMode`：如果发生过排序动作则为 `ranked`，否则为 `direct`（直接接受默认顺序）。

`ranking`/`rankingRelations`/`excludedImageIds`/`correctImageIds` 的后端校验见 `server/src/app.js` 的 `parseTaskRanking`、`parseTaskRankingRelations`、`parseTaskExcludedImageIds`、`parseTaskCorrectImageIds`：排序必须覆盖所有未排除图片且不重复，关系长度必须等于排序长度减一。

### 6.2 标签怎么读

- **成对偏好**：`ranking` 就是偏好顺序；`">"` 是严格偏好，`"="` 是平局。
- **不是绝对分**：没有“这张图 8 分”的信息，只有相对关系。
- **direct vs ranked**：`direct` 是没有主动拖拽的提交，偏好信号较弱；训练时建议至少按 `submissionMode` 分层或只取 `ranked`。
- **排除**：`excludedImageIds` 是“该图不适合这个维度”，不是“差”。丢弃还是保留取决于任务定义。
- **正确性**：`correctImageIds` 只在两个维度出现，含义是“肢体正常 / 文字正确”，与“更好”是两套标签，不能混用。

### 6.3 回测任务（45,933 条，4.99%）

- `isBacktest=true`，`taskType` 末尾多一段 `:backtest:<uuid>`，`id` 就是这个 uuid；
- `backtestSourceTaskId` 指向被回测的原任务，图片对与原任务相同；
- 回测用于抽查打分一致性，**不是独立样本**。做训练集时应 `filter(!isBacktest)`；做一致性分析时则按 `backtestSourceTaskId` 配对。
- 抽样核验：GEN_ROLL 的 1,199 条回测中 1,077 条能在同一切片找到原任务；UNKNOWN 的 2,651 条全部能找到。找不到的通常是原任务已回退/删除。

### 6.4 时间与耗时

- `completedAt` 全量范围：**2026-10-29T23:07:03.504Z ～ 2026-11-06T05:01:55.414Z**，全部不晚于快照点 `05:01:55.529Z`。
- `createdAt` 最早为 `2026-10-29T19:16:00.070Z`；另有 2 条异常记录（见 §8）。
- 耗时（抽样）：中位数约 3.4–4.9 秒，P90 约 9–15 秒；长尾很长（有挂机到数十分钟甚至小时的记录），做特征时要截断/取对数。

### 6.5 抽样画像（两个全量切片）

| 指标 | anatomyNormality__GEN_ROLL（24,477 条） | saturation__UNKNOWN（52,940 条） |
|---|---:|---:|
| `submissionMode=direct` | 20,382（83.3%） | 36,225（68.4%） |
| `submissionMode=ranked` | 4,095（16.7%） | 16,715（31.6%） |
| `largeImageOpened=true` | 22,396（91.5%） | 21,819（41.2%） |
| 有 `excludedImageIds` | 3,871（15.8%） | 0 |
| 有 `correctImageIds` | 16,818（68.7%） | 0 |
| `isBacktest=true` | 1,199（4.9%） | 2,651（5.0%） |
| `editCount>0` | 179（0.7%） | 148（0.3%） |
| `rankingRelations="="`（抽样 2,000） | 204 | 70 |
| `thumbnailUrl=null`（抽样 2,000） | 100% | 0% |
| `prompt=null`（抽样 2,000） | 100% | 0% |

（前 7 行是全量统计，后 3 行是前 2,000 条抽样；不同项目/图包的缩略图和 prompt 覆盖率差异很大。）

### 6.6 为什么有 52,940 条 UNKNOWN

这 52,940 条全部是 `saturation` 维度、来自 `V4_IMAGES_01` / `V4_IMAGES_02`。它们的图源路径根目录有 10 种：

| 路径根 | 出现次数（图数） | 是否在 GEN 白名单 |
|---|---:|---|
| u15_sft | 26,463 | 是 |
| u16_mt | 26,412 | 是 |
| Z-Image-Turbo | 10,635 | 否 |
| gemini-3.1-flash-image | 10,566 | 否 |
| seedream-5.0-pro | 10,550 | 否 |
| wan-2.7-pro | 10,099 | 否 |
| seedream-5.0-pro__qwen2512_remaining | 6,784 | 否 |
| FLUX.2-dev | 4,306 | 否 |
| u16_mt_part_a | 33 | 是（含 `u16_mt` 子串） |
| u15_sft_part_a | 32 | 是（含 `u15_sft` 子串） |

关键事实：**这 52,940 条任务中，每一条都是「一个白名单内模型（u15_sft/u16_mt）+ 一个白名单外模型」**（两者都识别的 0 条，都不识别的 0 条）。所以它们大概率仍是 `GEN_GEN`，只是分类器不认识新模型名。若要用于训练，建议按“模型 ∈ {Z-Image-Turbo, gemini-3.1-flash-image, seedream-5.0-pro, wan-2.7-pro, FLUX.2-dev, ...}”补一条 GEN 规则，把它们并入 `GEN_GEN`，而不是当成未知质量数据丢弃。

### 6.7 项目名与维度的“错位”

数据里有明显的命名不一致，**不要用项目名推断评分维度**，一律以 `criterion` 为准：

- `V4_REAL_1.6` 的 42,000 条任务全部是 `color` 维度；
- `V4_COLOR_1.6` 的 40,719 条任务全部是 `realism` 维度（`realism__GEN_GEN` 切片里约 57% 来自它）。

这看起来是建项目时把两个批次的名字接反了，但数据本身是自洽的（`taskType`、`criterion`、切片文件名三者一致，已核验）。

---

## 7. 怎么读、怎么用

### 7.1 读取

每个分片是一个整体 JSON 对象，解压后单行、体积可达 1 GB 级别（100,461 条的 `creativity__GT_GT` 约 900 MB 文本）。**不要**直接 `JSON.parse` 整个大分片，也不要用按行处理的工具。

推荐流式读取：

```python
import gzip, ijson

with gzip.open(path, "rb") as f:
    for task in ijson.items(f, "tasks.item"):
        process(task)
```

Node.js 可以直接复用 `operations/v4-slice-completed-export.mjs` 里的 `taskObjectsFromGzip()`：它先找 `"tasks":[` 标记，再做字符串/括号状态机逐个产出任务对象，内存占用与文件大小无关。

只想知道条数时，可以不解码整个 JSON：

```bash
# 每个任务恰好有一个 "id":"（图片是 "_id"/"imageId"），可用来快速计数
gzip -dc file.json.gz | LC_ALL=C grep -o '"id":"' | wc -l
```

（本包 20 个分片用这个方法统计的总数正好是 920,503，与 manifest 一致。）

### 7.2 构造训练/评测样本

```text
对每条 task：
  1. 过滤 isBacktest == true（如果要独立样本）
  2. 取 pair = items[0].imageId, items[1].imageId
  3. excluded = set(excludedImageIds)
  4. 若任一张在 excluded 中 → 该 pair 对这个维度无标签，丢弃或单独处理
  5. 若 ranking.length == 2：
        rankingRelations[0] == ">" → 前者胜
        rankingRelations[0] == "=" → 平局
     若 ranking.length == 1（另一张被排除）→ 只有单边，不能构成偏好
  6. label 的口径 = criterion（7 个维度可以分别建模，也可以合并）
```

### 7.3 图片

JSON 里只有相对 URL，没有图片二进制：

- `imageUrl` 形如 `/files/<storagePath>`，拼上部署域名即可访问；
- 若直接读盘：`${RATING_DATA_DIR}/uploads/` + `imageUrl` 去掉 `/files/` 前缀；
- `thumbnailUrl` 可能为 null，回退用 `imageUrl`；
- 同一 `imageId` 在不同任务中复用，去重后可大幅减少下载量（本包任务数 92 万，但图片数远小于此）。

### 7.4 完整性校验

```bash
cd V4_ALL_COMPLETED_slices_2026-11-06T05-01-55-529Z

# 1) 用 manifest 校验每个分片
jq -r '.slices[] | "\(.sha256)  \(.filename)"' manifest.json | shasum -a 256 -c -

# 2) 校验分片条数与 manifest 是否一致（需 ijson 或 §7.1 的流式脚本）
```

tar 本身不带校验和；以 `manifest.json` 的 `sha256` 与 `sourceSha256` 为准。

### 7.5 复现

```bash
# 1) 从数据库导出全量已完成任务（需要 DATABASE_URL 等环境变量）
node operations/v4-export-all-completed.mjs

# 2) 按维度 × 图源对切片
SOURCE_PATH=/path/V4_ALL_COMPLETED_2026-11-06T05-01-55-529Z.json.gz \
EXPECTED_TASK_COUNT=920503 \
SOURCE_SHA256=24785aa865731cd796087d6cb934ee5aebdc44956414d8e68c3b81e449771d30 \
OUTPUT_DIR=/path/out \
node operations/v4-slice-completed-export.mjs
```

---

## 8. 已知问题与坑（务必注意）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | 行为/风控字段未 SELECT：`dragActionCount`、`orderChanged`、`largeImageOpenCount`、`firstActionMs`、`pageBlurCount`、`behaviorTracked`、`riskScore`、`riskFlags` 恒为默认值 | 不能做行为分析/风控建模；会误以为“没人拖拽/没有风险” | 只用 `submissionMode`、`rankingActionCount`、`largeImageOpened`；需要行为字段请改导出 SQL 重新导出 |
| 2 | `image` 对象缺 `filename` | 依赖文件名的下游会拿到 undefined | 用 `_id` / `originalPath` / `imageUrl` |
| 3 | 2 条 `createdAt` 为 2486 年（`realism__GEN_GEN`，id 分别以 `e6dd0a21…`、`f97bf90e…` 开头） | 按时间排序/过滤会异常 | 用 `completedAt` 做时间轴；必要时修正这 2 条 |
| 4 | `UNKNOWN` 5.75%（52,940 条） | 被误当脏数据丢弃 | 见 §6.6，补 GEN 规则后可归入 `GEN_GEN` |
| 5 | 项目名与维度错位（`V4_REAL_1.6`→color，`V4_COLOR_1.6`→realism） | 按项目名筛选会拿错维度 | 以 `criterion` 为准 |
| 6 | `subjectName` 实际是项目名，`subjectId` 是图包 id | 容易把两者混用 | `projectId` 对项目，`subjectId` 对图包；二者多对多 |
| 7 | `direct` 提交占比高（60%–85%） | 大量样本没有主动排序动作 | 训练时分层/加权，或只取 `ranked` |
| 8 | 缩略图/prompt 覆盖率因图包而异（有的 100% null） | 不能假设字段总是有值 | 使用前统计空值率 |
| 9 | 分片是单行大 JSON | `jq`/`JSON.parse` 可能 OOM | 用流式解析 |
| 10 | tar 无内建校验 | 传输损坏不易发现 | 用 manifest 的 sha256 校验 |

---

## 9. 附：字段与数据库列的对应

`task` 字段（除派生字段外）来自下面的查询（`server/src/services/admin-dashboard.js:244`）：

```sql
SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
       rating_tasks.taskVersion, rating_tasks.taskType, rating_tasks.status,
       rating_tasks.scorer, rating_tasks.ranking, rating_tasks.excludedImageIds,
       rating_tasks.correctImageIds, rating_tasks.rankingRelations,
       rating_tasks.submissionMode, rating_tasks.rankingActionCount,
       rating_tasks.largeImageOpened, rating_tasks.isBacktest,
       rating_tasks.backtestSourceId, rating_tasks.startedAt,
       rating_tasks.completedAt, rating_tasks.durationMs, rating_tasks.editedAt,
       rating_tasks.editCount, rating_tasks.rollbackCount,
       rating_tasks.lastRolledBackAt, rating_tasks.lastRolledBackBy,
       rating_tasks.imageKey, rating_tasks.createdAt, rating_tasks.updatedAt,
       projects.name AS subjectName
FROM rating_tasks
JOIN projects ON projects.id = rating_tasks.projectId
WHERE rating_tasks.taskVersion = 'v3'
  AND rating_tasks.status = 'completed'
  AND rating_tasks.projectId IN (...)
  AND rating_tasks.completedAt <= '2026-11-06T05:01:55.529Z'
ORDER BY rating_tasks.id ASC
```

- `criterion`、`projectId`、`subjectName`、`items` 是组装时补的；
- `claimToken` 被显式置空；未出现在 SELECT 里的列在 JSON 中表现为默认值（§4.2）；
- `round`、`assignmentKey`、`claimedAt`、`claimExpiresAt`、`riskFlags` 原值等**没有**进入本导出。

`items[]` 来自 `rating_task_items`（`taskId, imageId, position, role`）与 `images`（`id, subjectId, filename, originalPath, storagePath, thumbnailPath, category, directory, isInfographic, prompt`）的联查，再由 `taskImageDto` 组装。

---

## 10. 附：JSON Schema

配套 schema 见 `docs/schemas/v4-completed-slice.schema.json`（JSON Schema 2020-12），描述单个分片文件的结构。注意它按本包实际字段编写：

- `tasks[].items` 允许 1–5 个（平台通用），本包实际全部为 2 个；
- `image.filename` 为可选（本包缺失）；
- 行为字段的“恒默认值”是数据问题，schema 只约束类型，不约束取值。
