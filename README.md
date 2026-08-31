# 图片评分平台

## 一键启动

```bash
cp -n .env.example .env
# 编辑 .env，将 POSTGRES_PASSWORD 改成实际密码
docker compose up --build -d
```

打开 `http://localhost:8080`。应用运行时使用 Compose 中的 `postgres:18-trixie`。
已有 SQLite 数据时，请先按 [DEPLOY.md](DEPLOY.md) 第 8 节完成迁移，再启动 API。

## 使用流程

1. 使用管理员账号登录后，在“项目管理”上传 ZIP。每个 ZIP 会创建一个独立项目。
2. ZIP 处理完成后，在项目任务页面按轮次生成并分配排序任务。
3. 打分账号登录后，在“任务列表”领取分配给自己的五图排序任务并提交。
4. 已完成任务保存打分人、完成时间、用时、排序结果、并列关系和不适用图片；修改任务不会覆盖初次完成时间和用时。

数据库目标为 Docker Compose 中的 `postgres:18-trixie`，数据持久化在宿主机 `${POSTGRES_DATA_DIR}`（默认 `/var/lib/rating/postgres`）。上传图片保存在 `${RATING_DATA_DIR}/uploads`。

ZIP 内目录示例：

```text
本次数据.zip
├─ sample_000001.png
├─ 信息图/
│  └─ sample_000002.png
└─ manifest.json
```

`信息图/` 下的图片会追加信息图专属维度，其他图片按通用维度创建任务。`manifest.json` 为可选文件，服务端以压缩包内图片文件名匹配其中的 `dest_rel_path` / `image_filename` 并保存 prompt 和图片详情；缺少 manifest 不会导致导入失败。支持 jpg、jpeg、png、webp、gif。开发时先分别在 `server`、`client` 运行 `npm install`，再执行根目录的 `npm run dev`。
