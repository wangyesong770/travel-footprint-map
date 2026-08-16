# Production deployment

生产地址：<https://www.loomi-ai.cn/travel-footprint-map/>

## Layout

```text
/var/www/travel-footprint-map/
├── current -> releases/<git-sha>
└── releases/
    └── <git-sha>/index.html
```

每次发布把 `dist/travel-map.html` 安装为新的不可变 `releases/<git-sha>/index.html`，核对 SHA-256 后再原子切换 `current` 符号链接。Nginx 规则见 `nginx-location.conf`。

本机 `/etc/nginx/conf.d/loomi.conf` 由 `loomi-nginx-guard` 守护；更新路由时必须让 `loomi.conf.canonical` 与 live 配置保持一致，并在 reload 前执行 `nginx -t`。只做平滑 reload，不重启应用后端。

## Smoke checks

- `/travel-footprint-map` 返回 301 到带斜杠路径。
- `/travel-footprint-map/` 返回 200、`text/html`、`Cache-Control: no-cache`。
- 线上响应 SHA-256 与发布文件一致。
- `/` 仍返回原站既有的 `/lims/` 跳转。
- 真实浏览器能渲染地图并完成离线城市搜索，控制台无错误。

## Rollback

把 `current` 原子切回上一版本目录即可回滚静态应用，无需 reload Nginx。若回滚路由配置，则同时恢复 canonical/live 两份备份，先执行 `nginx -t`，再平滑 reload。
