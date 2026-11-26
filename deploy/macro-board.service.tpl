[Unit]
Description=Macro Research Board
Documentation=https://github.com/jiayigu-cpu/macro-research-board
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__APP_USER__
Group=__APP_USER__
WorkingDirectory=__APP_DIR__
Environment=NODE_ENV=production
Environment=PORT=__PORT__
Environment=HOST=127.0.0.1
Environment=PYTHON=__APP_DIR__/venv/bin/python
Environment=AUTO_FETCH=1
Environment=STALE_HOURS=__STALE_HOURS__
Environment=TZ=Asia/Shanghai
ExecStart=__NODE__ server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
