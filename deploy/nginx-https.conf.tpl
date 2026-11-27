# HTTPS 版：80 段保留证书续期目录并整站跳转，TLS 段同时监听 443 与备用端口
# 由 deploy/setup-https.sh 注入 HTTP_PORT / HTTPS_LISTEN / REDIRECT / REDIRECT_IP / DOMAIN / BACKEND
server {
    listen __HTTP_PORT__;
    listen [::]:__HTTP_PORT__;
    server_name __DOMAIN__;

    access_log /var/log/nginx/macro-board.access.log;
    error_log  /var/log/nginx/macro-board.error.log;

    # 证书续期必须走这里，所以 80 段不能删
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }

    location / {
        return 301 __REDIRECT__;
    }
}

# 其它 Host（用 IP 直连、旧书签）统一跳到域名，否则会落到证书不匹配的 https://IP
server {
    listen __HTTP_PORT__ default_server;
    listen [::]:__HTTP_PORT__ default_server;
    server_name _;

    access_log /var/log/nginx/macro-board.access.log;
    error_log  /var/log/nginx/macro-board.error.log;

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }

    location / {
        return 301 __REDIRECT_IP__;
    }
}

server {
__HTTPS_LISTEN__
    server_name __DOMAIN__;

    access_log /var/log/nginx/macro-board.access.log;
    error_log  /var/log/nginx/macro-board.error.log;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 223.5.5.5 119.29.29.29 valid=300s;
    resolver_timeout 5s;

    add_header Strict-Transport-Security "max-age=15552000" always;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
    gzip_proxied any;

    location / {
        proxy_pass http://__BACKEND__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
