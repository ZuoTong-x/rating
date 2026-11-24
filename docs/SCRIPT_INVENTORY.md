# 脚本与临时产物清单

本清单按运行角色整理工作区文件。`scripts/`、`operations/` 和 `outputs/` 均不属于 API 正常启动路径。发布脚本打包服务端与客户端源码、构建配置、部署文件和文档；历史数据处理脚本不会随常规发布包进入容器。运行历史脚本前需单独确认输入、目标路径及数据库环境。

| 位置 | 用途 | 当前处理方式 |
| --- | --- | --- |
| `scripts/package-release.ps1`、`scripts/package-release.sh`、根目录 `package-release.cmd`、`package-release.command` | Windows/macOS/Linux 发布包入口 | 保留。是常用发布工具；两套发布文件清单需同步维护。已补齐 Docker 构建必需的 `server/tsconfig.json`。 |
| `server/src/migrate-schema.ts`、`server/src/import-local.ts`、`server/src/backfill-thumbnails.ts`、`server/src/migrate-sqlite-to-postgres.ts` | `server/package.json` 中显式声明的管理命令 | 保留，属于后端工具，不是临时 AI 脚本。`migrate:schema` 参与部署流程。 |
| `server/scripts/seed-reference-task.mjs` | 本地测试账号参考图任务样例 | 保留为开发样例；不要用于线上。 |
| `scripts/v4-allocation-runner.mjs` 和 `v4-allocation-*.json` | V4 一次性配额、任务下发台账及配置 | 作为历史操作资料保留，见 `docs/V4_ALLOCATION_OPERATIONS.md`；不是 API 运行依赖。 |
| `operations/v4-*.mjs` | V4 完成任务导出和切片 | 保留为可复现的历史导出工具，见 `docs/V4_ALL_COMPLETED_slices_7x7_格式说明.md`。 |
| `operations/repair-*.sql` | 已执行或准备过的线上定点修复 | 保留审计记录；禁止当作通用迁移脚本自动执行。 |
| `scripts/build_*.py`、`scripts/split_*.py`、`scripts/stream_*.py`、`scripts/repack_*.py`、`scripts/zip_*.py`、`scripts/consolidate_*.py`、`scripts/flatten_*.py` | 历史图包构建、拆分、转换、上传前处理 | 归为离线数据工具。参数和输入依赖具体批次；不应放进 API 启动或发布流程。 |
| `scripts/parallel_upload_*.py`、`scripts/download_*.py`、`scripts/run_*.ps1`、`scripts/run_remaining_v030_queue.py` | 历史传输与 V030 批次流水线 | 归为离线传输工具；可能访问外部主机或修改文件，使用前单独复核。 |
| `scripts/repair_*.py`、`scripts/diagnose_*.py`、`scripts/inspect_*.py`、`scripts/map_selected_export_images.mjs`、`scripts/validate_task_package.py` | 历史数据诊断、修包、校验 | 归为离线诊断工具；与数据库索引修复 SQL 不同。 |
| `outputs/` | 报表、预览图、探查结果和临时脚本，共 45 个文件（2026-11-16 盘点） | 本地生成物，已加入 `.gitignore`；不随发布打包，不自动删除用户数据。 |
| `server/logs/` | 本地 API 与 Worker 运行时日志 | 已加入 `.gitignore`；仍保留本地日志，不进入发布包。 |
| `scripts/__pycache__/`、`.DS_Store` | Python/macOS 自动生成的缓存 | 可重建的杂项，已加入 `.gitignore`；12 个被 Git 追踪的 `.pyc` 已从工作区删除，后续缓存不会重新加入版本控制。 |

`ssh.md` 和 `upload.md` 是人工操作笔记，可能含环境地址或访问凭据。它们不属于应用源码，分享仓库或制作交付包前应单独审查；本次没有移动、复制或输出其中的凭据。

本轮清理已移除未被源码引用的客户端全局 Naive UI 注册插件、服务端反馈模块中未导出也未被调用的旧回复函数、服务端入口未调用的 SQL prepared statement、上传任务中未调用的限速变换器，以及客户端和服务端对根包 `image-rating-platform` 的无用 `file:..` 依赖；同步更新 npm/pnpm 锁文件。历史修复 SQL、V4 台账与离线数据脚本仍按上表保留。

后续若确认离线数据工具不再使用，可以按批次移入独立归档仓库。当前文档和操作记录仍引用原路径，因此本次保持脚本路径不变。
