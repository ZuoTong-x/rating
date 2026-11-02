# 图包导入 JSON 示例

这个目录是一套最小可用的导入文件示例。将它和实际图片一起压缩成 ZIP 后，可以作为图包导入的参考。

## ZIP 目录结构

```text
example-package.zip
├─ manifest.json
├─ tasks.json
└─ images/
   ├─ cat-001.png
   ├─ cat-002.png
   ├─ cat-003.png
   ├─ dog-001.jpg
   ├─ dog-002.jpg
   └─ dog-003.jpg
```

`manifest.json`、`tasks.json` 必须放在 ZIP 根目录。图片可以放在子目录中，但 JSON 中的路径必须和 ZIP 内的实际相对路径完全一致。

## manifest.json 的作用

`manifest.json` 保存图片的附加信息，例如：

- 图片相对路径
- 原始提示词
- 使用的模型
- 图片宽高
- 其他目录或业务元数据

服务端优先使用 `src_rel_path` 匹配图片，也支持 `dest_rel_path`、`image_filename` 和文件名兜底匹配。推荐始终填写完整的 `src_rel_path`，避免不同目录中存在同名文件时匹配错误。

如果某一行 manifest 匹配不到图片，图片仍可能被导入，但这张图片的 prompt 等元数据会为空。

## tasks.json 的作用

`tasks.json` 保存任务模板。每个任务包含：

- 唯一任务 ID
- 评分维度 `criterion`
- 参与排序的图片列表
- 可选的图片角色 `role`

如果存在有效的 `tasks.json`，项目会使用这里定义的任务分组、维度和图片顺序，不会重新随机组合图片。

## 校验规则

- `tasks` 中的 `id` 不能重复。
- `criterion` 必须是系统支持的评分维度。
- 普通任务包含 1 到 5 张图片；`saturation`（饱和度）任务必须正好包含 2 张图片。
- 同一任务内不能重复引用同一张图片。
- 每个图片路径必须能唯一匹配 ZIP 中的图片。
- 同一个评分维度和相同图片集合不能重复。
- 图片角色只能使用 `target`、`filler`、`anchor_low`、`anchor_high`、`boundary`。

## 导入建议

1. 先确认图片实际存在，并核对文件名大小写。
2. 确认 JSON 中使用的是 ZIP 内相对路径，而不是本地绝对路径。
3. 将两个 JSON 放在 ZIP 根目录。
4. 导入后检查图包状态是否为 `imported`。
5. 再检查图片数量、任务模板数量和各评分维度数量。

`manifest.json` 主要描述图片，`tasks.json` 才决定后续可以生成哪些评分任务。只有图片而没有有效 `tasks.json` 时，图包可能可以导入成功，但项目可生成的任务数量可能为 0。
