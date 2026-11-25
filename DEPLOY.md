# 图片评分平台部署流程

这份文档用于把当前项目部署到服务器。数据库使用同一 Compose 中的 `postgres:18-trixie` 容器。

## 1. 部署架构

- `web`：前端静态页面，运行在 Nginx 容器里，对外暴露 `8080` 端口。
- `api`：Node.js / Express 服务，处理 ZIP 分片上传、图片解析、评分保存。
- `postgres`：`postgres:18-trixie` 数据库容器。
- `schema-migrate`：一次性数据库结构迁移，成功后 API 才会启动。
- `thumbnail-worker`：后台生成缩略图，会写入数据库和图片目录。
- `image-files`：只读提供图片文件。
- `${POSTGRES_DATA_DIR}`：保存 PostgreSQL 数据，默认 `/var/lib/rating/postgres`，挂载到容器 `/var/lib/postgresql`。
- `${RATING_DATA_DIR}/uploads`：保存解压后的图片文件。
- `${RATING_DATA_DIR}/inbox`：保存导入中的文件。

默认访问地址：

```bash
http://服务器IP:8080
```

## 2. 服务器准备

推荐环境：

- Linux 服务器，Ubuntu 22.04 / 24.04 或 CentOS 系均可。
- Docker 与 Docker Compose 插件。
- 至少 2GB 内存。
- 磁盘空间按图片 ZIP 包大小预留，建议至少 20GB 起。
- 放行端口：`8080`。如果配置域名和 HTTPS，再放行 `80`、`443`。

安装 Docker 的官方文档：

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable docker
systemctl start docker
docker --version
docker compose version
```

## 3. 一键部署

把代码放到服务器，例如：

```bash
cd /opt
git clone <你的仓库地址> image-rating-platform
cd image-rating-platform
```

如果没有 Git 仓库，也可以把项目压缩包上传到 `/opt` 后解压，进入项目根目录即可。

首次启动准备（先停止可能仍在运行的写入服务，再只启动 PostgreSQL）：

```bash
cp -n .env.example .env
# 编辑 .env，将 POSTGRES_PASSWORD 改成实际密码

# 停止 API、后台缩略图 Worker 和入口；不要在迁移期间启动这些服务
docker compose stop web api thumbnail-worker
# 如 schema-migrate 正在运行，先等待其完成并确认成功；不要并行执行迁移
docker compose ps -a
# 先只启动数据库，避免迁移期间产生写入
docker compose up -d postgres

# 默认使用 8080；如果外部访问端口是 8001，可加 WEB_PORT=8001
```

没有旧 SQLite 数据时，可直接执行 `docker compose up --build -d`；Compose 会先完成 `schema-migrate`，再启动 API、Worker 和 web。已有 SQLite 数据时，先完成第 8 节迁移，再启动整套服务。查看容器状态：

```bash
docker compose ps
```

打开浏览器访问：

```text
http://服务器IP:8080
```

看到页面后，进入管理页上传 ZIP 图包即可。

## 4. 常用运维命令

查看日志：

```bash
docker compose logs -f api
docker compose logs -f web
```

重启服务：

```bash
docker compose restart
```

停止服务：

```bash
docker compose down
```

更新代码后重新发布：

```bash
git pull
docker compose up --build -d
```

注意：不要删除 `${POSTGRES_DATA_DIR}` 或 `${RATING_DATA_DIR}/uploads`，这些目录保存数据库和上传图片。

## 5. 数据持久化位置

Docker 部署时，数据不会写在项目源码目录里，而是写入宿主机目录：

- PostgreSQL 数据库：`${POSTGRES_DATA_DIR}`（默认 `/var/lib/rating/postgres`，独立于 `RATING_DATA_DIR`）
- 上传图片：`${RATING_DATA_DIR}/uploads`
- 导入文件：`${RATING_DATA_DIR}/inbox`

查看目录占用情况：

```bash
set -a
. ./.env
set +a
# 与 Compose 中未设置或为空时的默认值保持一致
export RATING_DATA_DIR="${RATING_DATA_DIR:-/data/sunwenxiu/rating}"
export POSTGRES_DATA_DIR="${POSTGRES_DATA_DIR:-/var/lib/rating/postgres}"
du -sh "$POSTGRES_DATA_DIR"
du -sh "$RATING_DATA_DIR/uploads"
```

## 6. 备份数据

使用 `pg_dump` 备份 PostgreSQL；图片目录单独备份。

在项目根目录执行：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > backups/postgres_$(date +%Y%m%d_%H%M%S).sql
tar czf backups/image_uploads_$(date +%Y%m%d_%H%M%S).tgz -C "$RATING_DATA_DIR/uploads" .
```

## 7. 恢复数据

先停止服务：

```bash
docker compose down
```

启动 PostgreSQL（恢复前必须先启动数据库容器）：

```bash
docker compose up -d postgres
```

恢复 PostgreSQL：

```bash
cat backups/你的_postgres_备份文件.sql | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

恢复图片目录：

```bash
find "$RATING_DATA_DIR/uploads" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar xzf backups/你的_uploads_备份文件.tgz -C "$RATING_DATA_DIR/uploads"
```

恢复后启动：

```bash
docker compose up -d
```

## 8. SQLite 首次迁移与正式启用

迁移窗口内先停止所有写入，再备份 SQLite 文件和上传图片。除了 API，`thumbnail-worker` 也会写数据库和图片，必须一并停止；若旧版本通过其他 Compose 项目、宿主机进程或导入脚本运行，也须单独停止。确认没有正在运行的 `schema-migrate` 或其他迁移任务，不要并行迁移。

在项目根目录执行：

```bash
docker compose stop web api thumbnail-worker
docker compose ps -a
docker compose up -d postgres
docker compose ps postgres
```

确认 PostgreSQL 状态为 `healthy` 后再继续。目标应是专用于本次首次迁移、没有既有业务数据的 PostgreSQL 数据库；脚本执行普通 INSERT，不会清空目标数据，也不是可重复导入工具。不要对正在使用的生产库试跑。

备份完成后，把旧 SQLite 文件只读挂载到临时 API 容器。使用 `--no-deps` 避免自动启动依赖迁移服务，使用 `--build` 确保执行当前代码；数据库已在上一步单独启动：

```bash
docker compose run --rm --no-deps --build \
  -v /path/to/image-rating.sqlite:/migration/image-rating.sqlite:ro \
  -e SQLITE_PATH=/migration/image-rating.sqlite \
  api npm run migrate:sqlite
```

迁移脚本会创建表、索引和统计触发器，在事务中导入数据并重建统计，提交后执行 `ANALYZE`。提交前失败会回滚；如果提交后的 `ANALYZE` 失败，数据已经提交，不能直接重跑导入。出现错误时先检查目标库状态。成功导入后抽查各表行数，再正式启动全部服务：

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 api
```

确认登录、项目列表、任务分配和评分写入均正常后，PostgreSQL 即为唯一运行库。保留 SQLite 备份一段观察期，回滚时先停止新 API 和 `thumbnail-worker`，再恢复旧版本/SQLite；切换后新增的 PostgreSQL 数据不会自动同步回旧 SQLite，回滚前须另行保留。

## 9. 域名和 HTTPS

如果你希望使用域名访问，建议让本项目继续监听 `8080`，在服务器宿主机 Nginx 上反向代理到 `127.0.0.1:8080`。

宿主机 Nginx 示例：

```nginx
server {
  listen 80;
  server_name your.domain.com;

  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

启用 HTTPS 可以使用 Certbot：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your.domain.com
```

## 10. 环境变量

API 已只使用 PostgreSQL；不要再设置 `DB_PATH` 或挂载 SQLite 数据目录：

```yaml
PORT: 3000
DATABASE_URL: postgresql://用户名:密码@postgres:5432/数据库名
UPLOAD_DIR: /app/uploads
PG_POOL_MAX: 24
PG_STATEMENT_TIMEOUT_MS: 15000
PG_LOCK_TIMEOUT_MS: 2000
```

`POSTGRES_PASSWORD` 必须通过 `.env` 或部署环境设置；不要提交到仓库。

`RATING_DATA_DIR` 配置上传图片、导入文件和日志的宿主机根目录，默认 `/data/sunwenxiu/rating`。`POSTGRES_DATA_DIR` 单独配置 PostgreSQL 数据目录，默认 `/var/lib/rating/postgres`，与 `.env.example`、Compose 保持一致。

修改路径只会改变挂载位置，不会迁移已有数据；指向空目录可能初始化新库，看起来像数据丢失。已有部署应先核对实际挂载并备份，不能仅改变量后重启来迁移数据。需要在宿主机执行备份或恢复命令时，先按第 5 节加载该变量。

按约 100 人同时使用的单 API 实例，以上连接配置最多约 24 条 PostgreSQL 连接。PostgreSQL 的 `statement_timeout` 限制单条 SQL 执行时间；连接池负责短时排队。若压测显示慢查询会造成大量等待，应优先优化 SQL/索引，再考虑继续增加连接数。

可选的安全和上传限制配置：

```yaml
COOKIE_SECURE: "true" # 通过 HTTPS 域名访问时开启
MAX_ZIP_BYTES: 1073741824
MAX_ARCHIVE_ENTRIES: 50000
MAX_ARCHIVE_UNCOMPRESSED_BYTES: 21474836480
MAX_IMAGE_UNCOMPRESSED_BYTES: 134217728
```

启用 `COOKIE_SECURE` 后，请确保浏览器始终通过 HTTPS 访问站点，否则登录 Cookie 不会被发送。

## 11. 常见问题

上传 ZIP 报 `413 Request Entity Too Large`：

- 检查本项目的 `client/nginx.conf` 是否包含 `client_max_body_size 64m;`。
- 如果前面还有宿主机 Nginx 或云厂商网关，也要把它们的上传限制调大。

页面能打开，但接口失败：

- 执行 `docker compose ps` 确认 `api` 和 `web` 都在运行。
- 执行 `docker compose logs -f api` 查看服务端错误。

重新部署后数据不见了：

- 检查 `POSTGRES_DATA_DIR`（默认 `/var/lib/rating/postgres`）是否仍然存在且有数据，并核对当前 Compose 配置和容器实际挂载。不要误查 `${RATING_DATA_DIR}/postgres`，也不要删除旧目录。

上传成功但图片不可访问：

- 执行 `docker compose logs -f api` 查看解压和文件保存日志。
- 确认 `$RATING_DATA_DIR/uploads` 正常挂载。

## 12. 本地开发启动

本地开发通过 Compose 启动 PostgreSQL。

```bash
npm run install:all
npm run dev
```

默认前端为 Vite 地址，后端为 `3000` 端口。生产环境优先使用 Docker Compose。
