# Root scripts
npm run dev:web
npm run dev:server
npm run dev:queue

# Redis 6.2.3 service notes

## Current Redis service

- Windows service name: `Redis`
- Service binary path: `E:\Redis-6.2.3\RedisService.exe`
- Redis 6.2.3 binary directory: `E:\Redis-6.2.3\bin`
- Redis data/config directory: `E:\Redis-6.2.3`
- Config file: `E:\Redis-6.2.3\redis-6.2-service.conf`
- Data file: `E:\Redis-6.2.3\dump.rdb`
- Service wrapper source: `E:\Redis-6.2.3\RedisService.cs`
- Service wrapper executable: `E:\Redis-6.2.3\RedisService.exe`

## Verify current Redis

```powershell
sc.exe qc Redis
Get-Service Redis | Format-List Name,Status,StartType
E:\Redis-6.2.3\bin\redis-cli.exe -p 6379 PING
$raw = & E:\Redis-6.2.3\bin\redis-cli.exe -p 6379 INFO server
$raw -split "`r?`n" | Where-Object { $_ -match 'redis_version|run_id|tcp_port|uptime_in_seconds|config_file' }
```

Expected result:

```text
PONG
redis_version:6.2.3
tcp_port:6379
config_file:/Redis-6.2.3/redis-6.2-service.conf
```

## Rollback note

The old Redis 5.0.14.1 backup directory was intentionally removed after confirming Redis 6.2.3 is stable.

If you need rollback instructions later, recreate a fresh Windows Redis service installation or restore a previously preserved full system backup. Do not rely on `E:\Redis-5.0.14.1-backup`; it no longer exists.
