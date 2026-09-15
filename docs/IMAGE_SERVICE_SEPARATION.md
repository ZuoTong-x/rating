# 图片服务分离说明

当前优化将图片静态资源从 API 进程中分离出来：

```text
浏览器
  └─ web nginx
      ├─ /api/*   -> api:3000
      └─ /files/* -> image-files:80
```

## 为什么要分离

打分端每个任务通常会加载 5 张缩略图，点击大图时还会加载原图。多人同时打分时，图片响应会占用 Node API 进程的连接、文件读取和事件循环调度能力，导致业务接口也被图片请求拖慢。

分离后：

- API 只处理登录、任务查询、提交、导入和管理接口。
- 图片由独立 Nginx 进程直接读取磁盘文件。
- `uploads` 目录对图片服务只读挂载，图片服务不能修改业务数据。
- 浏览器 URL 不变，仍然访问 `/files/...`。

## 本次配置

`docker-compose.yml` 新增 `image-files` 服务：

```yaml
image-files:
  image: nginx:1.27-alpine
  volumes:
    - ./deploy/image-files.nginx.conf:/etc/nginx/conf.d/default.conf:ro
    - ${RATING_DATA_DIR}/uploads:/usr/share/nginx/html/files:ro
```

`client/nginx.conf` 中：

```nginx
location ^~ /files/ {
  proxy_pass http://image-files:80;
}
```

图片服务配置在：

```text
deploy/image-files.nginx.conf
```

## 部署注意事项

1. 确认 `${RATING_DATA_DIR}/uploads` 是线上真实图包目录。
2. API 和 `image-files` 必须挂载同一个 uploads 目录。
3. API 挂载为读写，`image-files` 挂载为只读。
4. 前端仍然只访问同一个域名，不需要改数据库里的图片路径。
5. 如果图片目录缺失或路径不一致，分离后仍会返回 404，需要先修复文件挂载。

## 验证方式

部署后检查：

```bash
docker compose ps
curl -I http://127.0.0.1:${WEB_PORT}/files/某个真实图片路径
curl http://127.0.0.1:${WEB_PORT}/api/auth/session
```

预期：

- `/files/*` 由 `image-files` 返回，并带有 `Cache-Control: public, max-age=604800, immutable`。
- `/api/*` 仍由 API 返回。
- API 日志中不再出现大量图片文件请求。
