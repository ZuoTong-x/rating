# V4 1.6 持续分配台账

初始用户授权：以 `1.xlsx` 的 64 人、208000 条为总配额，含 5% 回测。
2026-11-03 用户更新为 79 人、312800 条累计总配额，原表由本次聊天中的名单扩展；
新增配额 104800，全部仍含 5% 回测。新名单保存于 `scripts/v4-allocation-quota-update-20261103.json`。
最新验收结果：7 个项目累计分配 265360（基础 252092、回测 13268），总配额剩余 47440。
原 208000 条计划已补齐；两组自动监听项目均已完成并核验，heartbeat `v4` 已删除。
必须先补齐原 64 人的原配额（更新配额时剩余 5760 条，现已在 CREATIVITY 中补齐）；再分配新增人员和原人员增加的额度。
该优先级按已分配及已完成的实际数量核对，不要求人员先完成评分；也不调整已有分配。
台账 `priorityRoster` 保留原表配额和行序，`roster` 使用新表行序和累计配额。
分配可在同一新项目中跨越两个阶段，但必须先将原配额补满，再按新增余额比例分配。
仅登记用户在聊天中明确给出的项目或图包；REAL 不属于本名单。以后用户给项目名时加入计划，
给图包时先按数据集分组、核对导入状态、创建项目再加入。共同名称去除分片编号作为默认项目名。
缺少模板或仍在导入的数据须先标记等待，不能作为零容量成功分配。

线上：`sensebench@101.89.57.33`，部署 `/home/sensebench/sunwenxiu/rating_v42`。
运行器放在 API 容器 `/app/server/operations/`，持久文件在
`/app/uploads/_allocation-plans/v4-1.6-remaining/`（主机 `/data/sunwenxiu/rating/uploads/_allocation-plans/v4-1.6-remaining/`）。
其中 `ledger.json` 为权威台账，`ledger.csv` 为可读数量表，`events.jsonl` 为执行日志。
这些文件必须保留到本配额全部完成，并在后续分配前与线上实际任务核对。

```sh
docker compose exec -T api node operations/v4-allocation-runner.mjs init
docker compose exec -T api node operations/v4-allocation-runner.mjs repair-check
docker compose exec -T api node operations/v4-allocation-runner.mjs repair
docker compose exec -T api node operations/v4-allocation-runner.mjs run
docker compose exec -T api node operations/v4-allocation-runner.mjs sync
docker compose exec -T api node operations/v4-allocation-runner.mjs queue-project PROJECT_NAME
docker compose exec -T api node operations/v4-allocation-runner.mjs add-project PROJECT_NAME
docker compose exec -T api node operations/v4-allocation-runner.mjs create-project PROJECT_NAME PACKAGE_NAME...
docker compose exec -T api node operations/v4-allocation-runner.mjs set-quotas operations/v4-allocation-quota-update-20261103.json
```

`add-project` / `create-project` 只登记，不自动运行；核对登记后用 `run` 执行。
已有分配正在运行时，用 `queue-project` 把用户新指定的项目记入持久 `project-requests.jsonl`。
当前批次完成后逐条核对请求、修复需要恢复的模板、`add-project` 再 `run`；不能重复登记已存在的项目。
`repair-check PROJECT_ID` 可在分配中只读检查其他项目，`repair PROJECT_ID` 必须等待当前分配结束再执行。
每人 20 条为一个分配单位（19 基础+1 回测），按剩余额度比例采用最大余数法，同行余数按原表行序。
有 `priorityRoster` 时先在原表行序分配原配额余额，填满后按新表行序分配新增余额。
`set-quotas` 复核线上任务、名单和已完成项目；保存变更前台账备份及配额来源，重复执行同一版本不会重置优先级。
首批三个项目分别 42000、42000、24880；首批之后尚余 99120。
台账只将 assigned/completed 计为占用，pending/已释放不占用。
如果出现 `needs_reconciliation`，必须先核对任务及评分结果；不能修改状态后直接重跑整批。
`run` 遇到已完成项目与原计划不符（例如任务后来被释放）也会停止，需重新核定该项目目标。

运行器通过临时模块复用线上现有私有校验/生成函数，不修改运行中的应用、不运行 schema 初始化、不新增公共接口。
每批 100，锁等待 30 秒，项目串行执行。运行时在既有 task_generation_jobs 中持久记录作业状态，
同时写独立台账；容器更换后须从本仓库脚本或主机 operations 目录重新部署运行器。

2026-11-03 执行结果（后续追加前仍须以线上台账重新核对）：

| 项目 | 基础任务 | 回测 | 合计 |
| --- | ---: | ---: | ---: |
| V4_CREATIVE_1.6 | 39900 | 2100 | 42000 |
| V4_COLOR_1.6 | 39900 | 2100 | 42000 |
| V4_GT_RE_1.6 | 23636 | 1244 | 24880 |
| V4_UG_1.6 | 48697 | 2563 | 51260 |
| V4_HUAMAN_1.6 | 39995 | 2105 | 42100 |
| V4_CREATIVITY_1.6 | 29982 | 1578 | 31560 |
| V4_COLORS_1.6 | 29982 | 1578 | 31560 |
| 累计 | 252092 | 13268 | 265360 |

前五个项目完成时，原 208000 条计划剩余 5760（32 人各余 100、32 人各余 80），此后已在 CREATIVITY 中补齐。UG 关联 `02_u_gen_vs_improved_part_01`～`13`，恢复 48707 个有效模板后追加分配。
GT_RE 恢复 23638 个模板和一张缺失图片；AVIF 无损转换为 WebP，解码像素一致。
两个项目均再次执行只读恢复检查，确认模板无遗漏、无图片待恢复。
本批 UG 个人配额为 32 人各 860、3 人各 760、29 人各 740，含 5% 回测；具体姓名以 `ledger.csv` 为准。
HUAMAN 关联 `human_part_01`～`10`，共 40000 个已导入模板，无需修复。本批分配 39995 个基础任务，
另生成 2105 个回测；32 人各 700、25 人各 620、7 人各 600，具体姓名以 `ledger.csv` 为准。
`verification.json` 保留完成后的数据库独立核验结果。

前五个项目完成且刚更新配额时，已占用数量为 202240，总待分配为 110560，
其中原计划优先待分配 5760、新增额度待分配 104800。`ledger.csv` 分别列出两部分余额。
本次仅更新配额和分配顺序，尚未新增项目；继续沿用用户提供项目名或图包名后再加入计划的规则。

用户随后授权自动监听第七、八批导入，并指定：
`creativity_part_01`～`10` → `V4_CREATIVITY_1.6`；`colors_part_01`～`10` → `V4_COLORS_1.6`。
本次 heartbeat 自动化 ID 为 `v4`，曾每两分钟检查，现已因两组均验收完成而删除。配置文件为
`scripts/v4-allocation-watch-20261103.json`，持久运行状态在台账同目录 `watch-creativity-colors.json`。
以每组全部 10 个 IMPORT_OK、QUEUE07/08_ALL_10_OK 和 imported 状态及有效模板为就绪条件；
某组就绪即可创建项目、关联图包、登记并串行执行分配，不必等待另一组。
不得重复导入、重启现有导入队列或改动另一个聊天的导入进度监听。
继续遵守先补原配额、再分新增额度的顺序。状态无变化时保持安静；项目完成、失败或需要处理时通知。
两组均分配完成并核验后删除该 heartbeat；累计配额先用完时也结束监听。
监听依赖本机开机及 Codex 桌面应用运行。

2026-11-03 03:57（北京时间），`V4_CREATIVITY_1.6` 已完成 31560 条分配，
其中基础 29982、回测 1578，79 人数量及数据库统计核验通过。
项目 ID `3ba9466c-7072-4521-9af0-4ec33fb2edd8`，作业 ID `4fc03a4f-569b-4483-8ec0-a2aca51f2c43`。
本次补齐原计划剩余 5760 条，并使用新增额度 25800 条；累计已占用 233800，待分配 79000。
两组各 30000 个模板均已导入、每包 taskFailedCount=0，导入核验保存在
`creativity-import-verification.json`、`colors-import-verification.json`；分配核验为 `verification-creativity.json`。
随后按串行规则创建 COLORS 并执行分配。

2026-11-03 04:15（北京时间）最终验收：`V4_COLORS_1.6` 完成 31560 条（基础 29982、回测 1578），
项目 ID `10fe27b4-932d-489d-a1b5-08c5eb52080a`，作业 ID `e163a3c8-0b81-449d-8c44-23453a7a1f0b`。
全名单 79 人的各项目计划数量、5% 回测和总配额均核验通过；COLORS 有 72 人获得任务，
另 7 人此前已达到累计配额，本项目计划分配为 0。没有重复基础任务或异常回测来源，项目统计一致。
最终独立数据库核验保存在 `verification-creativity-colors-final.json`，监听状态文件已标记 completed。
两组本次新增共 63120；累计分配 265360，仍待分配 47440，留给用户后续指定的项目或图包。
