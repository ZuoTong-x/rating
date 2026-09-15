FROM nginx:1.27-alpine

COPY deploy/image-files.nginx.conf /etc/nginx/conf.d/default.conf
RUN nginx -t

EXPOSE 80
