# SFTP 自动导入

## 1. 在服务器准备目录

在服务器上执行：

```bash
mkdir -p /data/sunwenxiu/rating/inbox
mkdir -p /data/sunwenxiu/rating/inbox/processed
docker compose up -d --build api
```

`docker-compose.yml` 会把宿主机的：

```text
/data/sunwenxiu/rating/inbox
```

挂载到 API 容器的：

```text
/app/inbox
```

## 2. 上传 ZIP

通过 SFTP 将 ZIP 上传为临时文件名，上传完成后再改成 `.zip`，避免脚本读到未传完的文件：

```text
example.zip.part
example.zip
```

## 3. 执行本地导入

在项目根目录执行：

```bash
docker compose exec -T api node dist/import-local.js /app/inbox/example.zip
```

导入成功后，命令会输出 JSON 结果，并将源文件移动到：

```text
/data/sunwenxiu/rating/inbox/processed/example.zip
```

导入失败时源文件会保留在 inbox，可修复 ZIP 后重试。

如果需要保留源文件，不移动到 `processed`：

```bash
docker compose exec -T api node dist/import-local.js /app/inbox/example.zip --keep
```

## 4. 输出结果

返回结果中的 `subject._id` 是导入包 ID。创建项目时，将它作为 `packageIds` 传给项目接口：

```json
{
  "name": "示例项目",
  "packageIds": ["subject._id"]
}
```

之后仍可通过网页生成任务，也可以调用：

```text
POST /api/projects/{projectId}/tasks/generate
```
