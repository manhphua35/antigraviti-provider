# Lệnh

Chạy lệnh CLI trong thư mục repo. `account` là tên gọi tắt của `accounts`. `key`, `api-key` và `api-keys` là tên gọi tắt của `keys`.

## Trợ giúp

```text
node src/cli.js help
node src/cli.js --help
node src/cli.js -h
```

## Đăng nhập và phiên

```text
node src/cli.js login
node src/cli.js login --no-browser
node src/cli.js login --port 51121
node src/cli.js login --out file
node src/cli.js login --code value
node src/cli.js refresh
node src/cli.js refresh --out file
node src/cli.js status
node src/cli.js status --out file
npm run login
```

## Tài khoản Gmail

```text
node src/cli.js accounts
node src/cli.js accounts list
node src/cli.js accounts ls
node src/cli.js accounts list --json
node src/cli.js accounts use <email>
node src/cli.js accounts switch <email>
node src/cli.js accounts rotate
node src/cli.js accounts reset-quota
node src/cli.js accounts reset-quota <email>
node src/cli.js accounts reset
node src/cli.js accounts reset <email>
node src/cli.js accounts remove <email>
node src/cli.js accounts rm <email>
node src/cli.js accounts delete <email>
node src/cli.js accounts argon <email> allow
node src/cli.js accounts argon <email> deny
node src/cli.js accounts argon <email> clear
```

## API key và token đã dùng

`keys`, `keys list` và `keys ls` in số request và token đã cộng dồn của từng key. Số chỉ tăng khi gọi qua `serve` bằng API key.

```text
node src/cli.js keys
node src/cli.js keys list
node src/cli.js keys ls
node src/cli.js keys list --json
node src/cli.js keys --json
node src/cli.js keys add
node src/cli.js keys add --name <ten>
node src/cli.js keys add --name <ten> --key <gia-tri>
node src/cli.js keys create --name <ten>
node src/cli.js keys edit <key_hoac_ten> --name <ten-moi>
node src/cli.js keys edit <key_hoac_ten> --enable
node src/cli.js keys edit <key_hoac_ten> --disable
node src/cli.js keys update <key_hoac_ten> --name <ten-moi>
node src/cli.js keys reset-usage
node src/cli.js keys reset-usage all
node src/cli.js keys reset-usage <key_hoac_ten>
node src/cli.js keys reset
node src/cli.js keys reset <key_hoac_ten>
node src/cli.js keys reset --name <ten>
node src/cli.js keys remove <key_hoac_ten>
node src/cli.js keys rm <key_hoac_ten>
node src/cli.js keys delete <key_hoac_ten>
```

Dòng token in ra có dạng `Tokens: 55 (prompt: 15, completion: 40)`.

- `prompt` là token đầu vào chưa nằm trong cache.
- `completion` gồm cả token suy luận.
- `Tokens` là tổng Google báo, gồm cả phần cache.

Xem token của đúng một lần gọi. Lần này không cộng vào bộ đếm của key. Số nằm trong trường `usage`.

```text
node src/cli.js generate --prompt "Hello" --json
```

## Model và generate

`--effort` nhận `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `--endpoint-mode` nhận `auto`, `production`, `sandbox`.

```text
node src/cli.js models
node src/cli.js models --json
node src/cli.js models --out file
node src/cli.js models --endpoint-mode auto
node src/cli.js models --endpoint-mode production
node src/cli.js models --endpoint-mode sandbox
node src/cli.js generate --prompt "Hello"
node src/cli.js generate --model <id> --prompt "Hello"
node src/cli.js generate --effort medium --prompt "Hello"
node src/cli.js generate --system "text" --prompt "Hello"
node src/cli.js generate --max-tokens 1024 --prompt "Hello"
node src/cli.js generate --temperature 0.7 --prompt "Hello"
node src/cli.js generate --endpoint-mode auto --prompt "Hello"
node src/cli.js generate --endpoint <url> --prompt "Hello"
node src/cli.js generate --show-thinking --prompt "Hello"
node src/cli.js generate --json --prompt "Hello"
node src/cli.js generate --new-session --prompt "Hello"
node src/cli.js generate --messages file.json
node src/cli.js generate --tools file.json --prompt "Hello"
```

## Server

```text
node src/cli.js serve
node src/cli.js serve --host 127.0.0.1 --port 8787
node src/cli.js serve --api-key <gia-tri>
node src/cli.js serve --api-key-file <file>
node src/cli.js serve --endpoint-mode auto
node src/cli.js serve --endpoint-mode production
node src/cli.js serve --endpoint-mode sandbox
node src/cli.js serve --auto-rotate
node src/cli.js serve --no-auto-rotate
node src/cli.js serve --body-limit-mb 20
npm run serve
```

## Build và test

```text
npm test
npm run build
npm run build:full
```

## Giờ trên VPS

Chạy sau khi đã SSH vào VPS.

```text
date
timedatectl
date -u
TZ=Asia/Ho_Chi_Minh date
```
