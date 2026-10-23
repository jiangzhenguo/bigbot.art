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

    # ⚠️ gzip 一定要开。公网链路上未压缩的 JS 是 1.4MB,压完 318KB。
    # gzip_proxied any 是关键 —— 默认 off 时代理来的响应根本不压。
    gzip on;
    gzip_proxied any;
    gzip_types text/javascript application/javascript text/css application/json image/svg+xml;
    gzip_min_length 1024;
    gzip_comp_level 5;
}
```

然后 `nginx -t && systemctl reload nginx`。

### 5.1 慢的根因:公网链路带宽,不是中继

**先量再改。** 判别方法:在服务器本机 `curl http://127.0.0.1:8443/<大文件>`(只走隧道)与在自己机器上 `curl https://域名/<大文件>`(多一跳公网)对比。

实测一次:1.4MB 的 JS

| 路径 | 耗时 | 带宽 |
|---|---|---|
| 服务器本机 → 中继 → Mac → 回来 | 0.61s | 2.3 MB/s |
| 自己机器 → nginx → 中继 → Mac → 回来 | 4.9s | 0.29 MB/s |

**⇒ 隧道本身很快,慢的是「服务器 → 浏览器」这一跳。** 国内家宽到某台云服务器只有 2~3 Mbps 很常见,ping 12ms 也照样慢(带宽不是延迟)。

**⇒ 别把时间花在调中继上。** 要提速只有三条路:**少传**、**压小**、**别重复传**。

### 5.2 三条提速手段(按收益排序)

**① 压缩。** 上面那段 gzip 就是第一位的:首屏 JS 1.4MB → 344KB,CSS 197KB → 38KB。

**② 缓存。** 两层都要:

- **源站**(Mac 端)已经会发正确的头:`/assets/*` 是 `public, max-age=31536000, immutable`(Vite 产物名带内容 hash),`index.html` 是 `no-cache` + ETag(变了回 304)。
- **nginx** 侧再加一层兜底(源站是旧版本时也生效):

```nginx
# 只给 200:404 缓存一年会把「暂时取不到」变成永久取不到
map $upstream_status $bba_asset_cache_control {
    200     "public, max-age=31536000, immutable";
    default "no-store";
}

location ^~ /bba/assets/ {
    # 结尾写 /assets/ :把匹配到的 /bba/assets/ 换成 /assets/,
    # 上游才拿得到 /assets/index-xxx.js(只写 / 会把整段前缀剥光 → 404)
    proxy_pass http://127.0.0.1:8443/assets/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    client_max_body_size 32m;
    gzip on;
    gzip_proxied any;
    gzip_types text/javascript application/javascript text/css application/json image/svg+xml;
    gzip_min_length 1024;
    # add_header 只是「加」,上游那条 no-cache 还在,浏览器会按最严的执行 ⇒ 必须先藏掉
    proxy_hide_header Cache-Control;
    add_header Cache-Control $bba_asset_cache_control always;
}
```

> `add_header` 不会替换上游同名头,只会再加一条。浏览器遇到 `no-cache` 和 `max-age=31536000` 会按最严的算,所以**必须 `proxy_hide_header Cache-Control`** 把它藏掉。

**③ 缩略图(最大的那一笔)。** 首页一次要显示十几个项目封面。**如果直接发全尺寸原图,实测是 19 张 / 27.6MB —— 在 2~3 Mbps 上就是一分多钟,而且这些大文件会把 HTML/JS/接口全堵在后面(表现为"连登录都慢")。**

现在渲染层会给封面和资产卡请求 `?w=480`,Mac 端服务���用系统自带的 `sips` 按最长边缩放并缓存到 `~/.bigbotart/thumbs/`(原图一改就自动重生成;sips 不可用就回退发原图,不会给不出来)。

⇒ 实测:首页媒体传输 27.6MB → **0.7MB**,冷加载可交互从一分多钟降到 **2.5 秒**,二次打开 **0.36 秒**。

**nginx 侧不用为缩略图做任何事** —— 它就是普通的一个 GET。

### 5.3 别的省事做法

- **开 HTTP/2**:`listen 443 ssl http2;`。慢链路上能省掉每个资源一次 TCP+TLS 握手。
- **换更近/更快的机器**:瓶颈是最后一跳带宽,换一台离用户近、或运营商线路更好的机器,收益比任何调参都大。
- **上 CDN**:静态资源(JS/CSS/图)放 CDN 就能绕开这条慢链路。前提是静态资源不从 Mac 来(要么定期同步到源站,要么做成构建产物上传)。

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
| **打开要等一分多钟,连登录都慢** | 链路带宽(见 §5.1),不是中继。先看首页是不是在拉全尺寸原图:DevTools 里筛 `/media/`,几十 MB 就是它 |
| 第二次打开还是慢 | 缓存头没生效。查响应里 `cache-control`:`/assets/*` 要 `immutable`,`/media/*` 要 `max-age`;nginx 侧记得 `proxy_hide_header Cache-Control` |
| 封面图糊 | 缩略图没生成(非 macOS 没有 `sips`):会回退发原图,看服务端有没有缩略图缓存目录 `~/.bigbotart/thumbs/` |
| 事件流连上就断 | nginx 没配 `Upgrade`/`Connection` 头与 `map $http_upgrade` |
| 中继日志反复「隧道断开」 | Mac 端没开中继开关、或配对密钥不对(看 Mac 端日志「配对密钥被拒绝」) |
