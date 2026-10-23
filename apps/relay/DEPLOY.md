# BigBotArt 中继部署

在已备案的域名上跑这一份 Node 服务。Mac 上的 BigBotArt 主动连出一条 WSS,浏览器只访问这台服务器。Mac 不需要安装 Tailscale 或其他穿透工具。

中继只认配对密钥。网页登录仍用 App 里生成的口令。会话在 Mac 进程内存里,App 重启后要重新登录。中继不记录请求体、cookie 或配对密钥。

## 两种部署形态

| | A. nginx 反代(推荐) | B. 中继自带证书 |
|---|---|---|
| 证书 | nginx + Certbot 管 | 中继自己向 Let's Encrypt 申请并续期 |
| 中继监听 | `127.0.0.1:8443`(纯 HTTP) | `0.0.0.0:443`(HTTPS) |
| 公网入口 | `https://域名/前缀/` | `https://域名/` |
| 适合 | 域名上已经挂着官网/别的服务 | 域名只给 BigBotArt 用 |

**大多数情况选 A。** 域名上已有站点时,应用挂在路径前缀下(例如 `/bba/`),两者互不干扰;证书续期也交给现成的 Certbot。

## A. nginx 反代(推荐)

### 1. 服务器准备

- 腾讯云北京(或任意能出 80/443 的 Linux),域名已做 ICP 备案
- DNS 的 A 记录已经指向这台机器(签证书之前就要生效)
- 安全组放行 TCP 80 和 443
- 下面命令用 root 执行

### 2. 装 Node 与代码

```bash
# Node 22(OpenCloudOS / RHEL 系用 dnf,Debian 系用 apt-get)
# 或直接放官方二进制:https://nodejs.org/dist/latest-v22.x/
node -v   # 必须是 v22 及以上
corepack enable && corepack prepare pnpm@11.0.8 --activate

id bigbotart >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin bigbotart
mkdir -p /opt/bigbotart /var/lib/bigbotart-relay
git clone --depth 1 https://github.com/jiangzhenguo/bigbot.art.git /opt/bigbotart
cd /opt/bigbotart
pnpm install --frozen-lockfile --filter @bigbotart/relay...
pnpm --filter @bigbotart/relay build
chown -R bigbotart:bigbotart /var/lib/bigbotart-relay
```

> 分支用 `main`。旧文档里的 `cursor/web-remote-phase1-b3d3` 早已合并,不要按它克隆。

### 3. 配置文件

```bash
cat >/etc/bigbotart-relay.env <<'EOF'
BBA_RELAY_MODE=http
BBA_RELAY_PORT=8443
BBA_RELAY_LISTEN=127.0.0.1
BBA_RELAY_DATA_DIR=/var/lib/bigbotart-relay
BBA_RELAY_DOMAIN=bigbot.art
EOF
chown root:bigbotart /etc/bigbotart-relay.env
chmod 640 /etc/bigbotart-relay.env
```

`BBA_RELAY_MODE=http` 表示只监听回环 HTTP,公网入口交给 nginx。配对密钥留空,首次启动会打印一次(见下)。

### 4. systemd

```bash
cp apps/relay/deploy/bigbotart-relay.service /etc/systemd/system/bigbotart-relay.service
# ⚠️ ExecStart 里的 node 路径按实际安装位置改:
#    /usr/bin/node(系统源) / /usr/local/bin/node(官方二进制、NodeSource)
sed -i 's#^ExecStart=.*#ExecStart=/usr/local/bin/node /opt/bigbotart/apps/relay/dist/cli.js#' \
  /etc/systemd/system/bigbotart-relay.service
systemctl daemon-reload
systemctl enable --now bigbotart-relay
journalctl -u bigbotart-relay -n 50 --no-pager
```

第一次启动,日志里有一行:

```text
BigBotArt 中继配对密钥(只显示这一次,请抄到 Mac 的设置里): <密钥>
```

抄到 Mac 的设置页(设置 → 远程访问 → 自建中继 → 配对密钥)。密钥同时写在 `/var/lib/bigbotart-relay/pairing.key`(模式 0600)。这一行会留在 journal 里;抄完后如需从日志抹掉,轮换一次密钥再执行 `journalctl --rotate && journalctl --vacuum-time=1s`。不要把密钥写进 git。

### 5. nginx 反代

在 `http {}` 块里加 WebSocket 升级映射(nginx 1.29 及以下默认没有):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

在域名 server 块里加路径前缀:

```nginx
location = /bba {
    return 301 /bba/;
}

location ^~ /bba/ {
    proxy_pass http://127.0.0.1:8443/;   # 结尾斜杠 = 把 /bba 前缀剥掉再转给上游
    proxy_http_version 1.1;

    # Host 必须保留原样:远端服务用它做 Origin 校验
    # (浏览器 Origin 的 host 必须与 Host 一致,否则登录被 403)
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket 升级(事件流 /bba/events)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # 画布快照与素材上传到 32MB,与远端服务上限对齐(默认 1MB 会 413)
    client_max_body_size 32m;

    # 视频 Range 与事件流不要攒在代理缓冲里
    proxy_buffering off;
    proxy_request_buffering off;

    # 事件流长连接 + 大文件下载
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    gzip off;
}
```

然后 `nginx -t && systemctl reload nginx`。

**三个必须照做的点:**

1. **`^~` 不能省。** 同一 server 里如果有 `location ~* \.(jpg|png|...)$` 这类正则块,它们优先级高于普通前缀 location,`/bba/assets/logo.png` 会被官网的静态目录抢走。加 `^~` 才轮到 `/bba/`。
2. **`proxy_pass` 结尾的斜杠不能省。** 带斜杠 = 用上游路径**替换掉**匹配到的前缀,中继看到的仍是干净的 `/`、`/rpc`、`/events`、`/bba-tunnel`;不带斜杠 = 原样转发 `/bba/rpc`,中继一律 404。
3. **`Host $host` 不能省。** 远端服务要求浏览器 Origin 的 host 与 Host 完全一致,否则 `/session` 直接 403。

### 6. Mac 端设置

设置 → 远程访问:

- 打开「远程访问」开关(会生成网页登录口令)
- 中继地址填**带前缀**的:`https://bigbot.art/bba`(结尾不要加斜杠)
- 配对密钥填服务器第一次启动时打印的那串
- 打开「自建中继」开关

网页端的接口前缀不是配置项,而是**由文档自己的 URL 目录推导**(渲染层用相对路径 `./assets/…` 引资源,页面在 `/bba/` 就落到 `/bba/assets/…`)。所以前缀两侧必须一致:nginx 剥 `/bba`,浏览器也必须待在 `/bba/` 下。

### 7. 验收

```bash
# 官网没被动过
curl -sI https://bigbot.art/ | head -1            # 200
# 前缀可达(隧道没连时是 503 的「隧道还没连上」页)
curl -s https://bigbot.art/bba/ | head -c 120
# 端到端:页面/资源/登录/RPC/事件流
node apps/desktop/scripts/verify-relay-public.mjs https://bigbot.art/bba '<网页登录口令>'
node apps/desktop/scripts/verify-relay-browser.mjs https://bigbot.art/bba '<网页登录口令>' /tmp/bba.png
```

### 8. 更新代码

```bash
cd /opt/bigbotart && git pull
pnpm install --frozen-lockfile --filter @bigbotart/relay...
pnpm --filter @bigbotart/relay build
systemctl restart bigbotart-relay
```

## B. 中继自带证书

把 `BBA_RELAY_MODE` 改成 `https`,`BBA_RELAY_LISTEN` 改成 `0.0.0.0`,并在 `/etc/bigbotart-relay.env` 里设置 `BBA_RELAY_CERT` 和 `BBA_RELAY_KEY`(完整链和私钥)。这种证书不会自动续期。不设置证书则向 Let's Encrypt 申请,到期前 30 天内自动续,HTTP-01 走 80 端口。80 端口在隧道没连上时也要能回答 `/.well-known/acme-challenge/`。

此时公网入口就是域名根路径,Mac 端中继地址填 `https://域名`(不带前缀),不需要 nginx。

## Docker(可选)

在仓库根目录:

```bash
docker build -f apps/relay/Dockerfile -t bigbotart-relay .
docker run --rm -p 80:80 -p 443:443 \
  -e BBA_RELAY_DOMAIN=art.example.com \
  -e BBA_RELAY_EMAIL=you@example.com \
  -e BBA_RELAY_DATA_DIR=/var/lib/bigbotart-relay \
  -v bigbotart-relay:/var/lib/bigbotart-relay \
  bigbotart-relay
```

容器里的 Node 以 root 监听 80/443。数据卷里会留下 `pairing.key` 和证书。

## 本机试跑(不申请证书)

```bash
cd /opt/bigbotart
BBA_RELAY_MODE=http BBA_RELAY_PORT=8080 BBA_RELAY_LISTEN=127.0.0.1 \
  BBA_RELAY_DATA_DIR=/tmp/bba-relay BBA_RELAY_PAIRING_KEY=本地试跑用的足够长的密钥 \
  node apps/relay/dist/cli.js
```

`BBA_RELAY_MODE=http` 只给排障。正式给浏览器用要走 HTTPS,否则会话 cookie 不会带 Secure。

## 排障

| 现象 | 多半是 |
|---|---|
| 页面打得开,接口全 404 | `proxy_pass` 结尾少了斜杠(前缀没剥掉) |
| 页面全白、资源 404 | `location` 少了 `^~`,被同 server 的正则 location 抢走;或渲染层构建被改成了绝对 base |
| 登录一直 403 | nginx 没保留原 Host(`proxy_set_header Host $host;`) |
| 登录成功但马上掉线 | cookie 没带 Secure:中继与 nginx 之间是明文 HTTP,Mac 端按 Origin 判断是否 https,浏览器 Origin 必须是 `https://` |
| 提交大画布 413 | nginx 的 `client_max_body_size` 没调到 32m |
| 事件流连上就断 | nginx 没配 `Upgrade`/`Connection` 头与 `map $http_upgrade` |
| 中继日志反复「隧道断开」 | Mac 端没开中继开关、或配对密钥不对(看 Mac 端日志「配对密钥被拒绝」) |
