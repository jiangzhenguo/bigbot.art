# BigBotArt 中继部署

在已备案的域名上跑这一份 Node 服务。Mac 上的 BigBotArt 主动连出一条 WSS,浏览器只访问这台服务器。Mac 不需要安装 Tailscale 或其他穿透工具。

中继只认配对密钥。网页登录仍用 App 里生成的口令。会话在 Mac 进程内存里,App 重启后要重新登录。中继不记录请求体、cookie 或配对密钥。

## 服务器要准备的

- 腾讯云北京(或任意能出 80/443 的 Linux),域名已做 ICP 备案
- DNS 的 A 记录已经指向这台机器(签证书之前就要生效)
- Node.js 22、安全组放行 TCP 80 和 443
- 下面命令用 root 执行

## 安装并启动

```bash
# Node 22(若已安装可跳过)。NodeSource 的安装脚本会改系统源。
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
corepack enable
corepack prepare pnpm@11.0.8 --activate

id bigbotart >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin bigbotart
mkdir -p /opt/bigbotart /var/lib/bigbotart-relay
# 把本仓库放到 /opt/bigbotart(已有目录就 git pull 对应分支)
git clone --branch cursor/web-remote-phase1-b3d3 https://github.com/jiangzhenguo/bigbot.art.git /opt/bigbotart
cd /opt/bigbotart
pnpm install --frozen-lockfile --filter @bigbotart/relay...
pnpm --filter @bigbotart/relay build
chown -R bigbotart:bigbotart /var/lib/bigbotart-relay

cp apps/relay/deploy/bigbotart-relay.env.example /etc/bigbotart-relay.env
# 编辑域名和邮箱。配对密钥可以先留空,首次启动会打印一次。
nano /etc/bigbotart-relay.env
chown root:bigbotart /etc/bigbotart-relay.env
chmod 640 /etc/bigbotart-relay.env

# 非 root 监听 80/443
sysctl -w net.ipv4.ip_unprivileged_port_start=80
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/99-bigbotart-relay.conf

cp apps/relay/deploy/bigbotart-relay.service /etc/systemd/system/bigbotart-relay.service
systemctl daemon-reload
systemctl enable --now bigbotart-relay
journalctl -u bigbotart-relay -n 50 --no-pager
```

第一次启动,日志里有一行:

```text
BigBotArt 中继配对密钥(只显示这一次,请抄到 Mac 的设置里): <密钥>
```

抄到 Mac 的设置页。密钥同时写在 `/var/lib/bigbotart-relay/pairing.key`(模式 0600)。这一行会留在 journal 里;抄完后如需从日志抹掉,轮换一次密钥再执行 `journalctl --rotate && journalctl --vacuum-time=1s`。不要把密钥写进 git。

更新代码后:

```bash
cd /opt/bigbotart && git pull
pnpm install --frozen-lockfile --filter @bigbotart/relay...
pnpm --filter @bigbotart/relay build
systemctl restart bigbotart-relay
```

## 自带证书

在 `/etc/bigbotart-relay.env` 里设置 `BBA_RELAY_CERT` 和 `BBA_RELAY_KEY`(完整链和私钥)。这种证书不会自动续期。不设置则向 Let's Encrypt 申请,到期前 30 天内自动续,HTTP-01 走 80 端口。80 端口在隧道没连上时也要能回答 `/.well-known/acme-challenge/`。

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

`BBA_RELAY_MODE=http` 只给排障。正式给浏览器用要走上面的 HTTPS,否则会话 cookie 不会带 Secure。
