# 纯 HTTP 版（还没有域名 / 证书时使用）
# 由 deploy/install.sh 注入 HTTP_PORT / SERVER_NAME / BACKEND
server {
    listen __HTTP_PORT__ default_server;
    listen [::]:__HTTP_PORT__ default_server;
    server_name __SERVER_NAME__;

    access_log /var/log/nginx/macro-board.access.log;
    error_log  /var/log/nginx/macro-board.error.log;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
    gzip_proxied any;

    # 证书续期用的 HTTP-01 验证目录，必须放在反代之前
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }

    location / {
        proxy_pass http://__BACKEND__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
