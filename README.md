# Stremio Torrent Stream

This self-hostable addon enables [Stremio](https://www.stremio.com/) to stream movies and shows from torrents. Works with both public and private trackers through [Jackett](https://github.com/Jackett/Jackett) and built-in scrapers. It uses [WebTorrent](https://github.com/webtorrent/webtorrent) under the hood.

![image](https://github.com/nyakaspeter/stremio-torrent-stream/assets/43880678/42040b81-2bf5-43f0-b827-9d62c3a1d79c)

## How to run

With Docker:
```
docker run -p 58827:58827 -p 58828:58828 nyakaspeter/stremio-torrent-stream
```

With Docker Compose (the addon and Jackett simultaneously):
```
git clone https://github.com/nyakaspeter/stremio-torrent-stream.git
cd stremio-torrent-stream
docker compose up
```

With Node.js and [pnpm](https://pnpm.io/installation):
```
git clone https://github.com/nyakaspeter/stremio-torrent-stream.git
cd stremio-torrent-stream
pnpm i
pnpm build
pnpm start
```

Once the addon server is up, you'll see a console output like this:
```
HTTP addon listening on port 58827
HTTPS addon listening on port 58828
```

On your local computer you can install the addon from http://localhost:58827 but if you want to use it with other devices you'll have install it from an HTTPS enabled address. I've bundled a wildcard certificate from [local-ip](https://local-ip.medicmobile.org/) with the server, which will provide valid HTTPS for your local IPs. To find out the HTTPS address of the addon take the LAN IP of the host and replace dots with hyphens, then append **.local-ip.medicmobile.org and the HTTPS port at the end**. Let's say the LAN IP of your machine hosting the addon on port **58828** is **192.168.0.10**, in this case you can install the addon from https://192-168-0-10.local-ip.medicmobile.org:58828.

If the above doesn't work for you, you can try opening an HTTPS tunnel to the addon server with [localtunnel](https://theboroer.github.io/localtunnel-www/). To do this set the environment variable `HTTPS_METHOD=localtunnel`. After you start the addon server you'll see this in the console:
```
Tunnel accessible at: https://some-random-domain.loca.lt
Tunnel password: x.xxx.xxx.xx
```

When you first open the localtunnel URL it will ask for a password, you can copy it from the console output. After submitting the password the browser will show the configuration screen for the addon.

## Configuring the addon

On the configuration screen you can set up your torrent site & Jackett credentials (they're optional) and configure torrent search settings.

![image](https://github.com/nyakaspeter/stremio-torrent-stream/assets/43880678/d9a581a9-8036-44ab-942a-3750261cb50c)

When you're done with the configuration hit the install button at the bottom, that will redirect you to Stremio where you can finally install the addon. If you've configured everything properly you'll see torrent results populating the stream list for movies and shows. Enjoy streaming!

## Memory usage and background downloads

With `KEEP_DOWNLOADED_FILES=true`, closing Stremio stops the HTTP stream, not the
torrent download. Downloading and seeding continue until `SEED_TIME` expires after
the last stream closes. `259200000` means 72 hours; `AUTO_SEED=true` also resumes
torrents from the seed directory after a restart. These behaviors are intentional.

WebTorrent normally caches 20 entire pieces **per torrent** in RAM. For example,
64 MiB pieces can retain 1.25 GiB just in that cache, independently of peer count.
The addon defaults to **5 cached pieces per torrent**, configurable with
`STORE_CACHE_SLOTS` for both new and resumed torrents:

```yaml
environment:
  - STORE_CACHE_SLOTS=5
```

Set it to `0` to disable the extra cache or `20` to restore WebTorrent's default
piece count. The value must be a non-negative safe integer; invalid values stop
startup with an error. Recreate the container after changing it. Metadata-only
lookups do not use this cache.

This is a piece count, **not a byte limit**: 5 pieces of 64 MiB can retain 320 MiB
per torrent, and multiple torrents multiply that amount. Files remain on disk.
In-flight downloads, hashing, HTTP buffers, and filesystem caching still
consume memory, so this is not a hard cap on total memory. HTTP streams use
backpressure and are cleaned up on disconnect, error, or timeout without
destroying the background torrent.

HTTP streams also check the requested byte count: upstream read failures that
end an iterator without emitting an error are reported as truncated streams,
not treated as successful responses.

The addon uses WebTorrent 3.0.21 with a committed pnpm scheduler patch. Upstream
[issue #1973](https://github.com/webtorrent/webtorrent/issues/1973) remains open;
an upgrade alone does not bound partial pieces or pending writes.

`DOWNLOAD_BUFFER_LIMIT=134217728` defaults to a **128 MiB shared download budget**
across new, resumed and metadata torrents, independent of their download speed.
Capacity is reserved **before requesting the first block of a piece** and held
through assembly, hashing and the disk-write callback. Each piece reserves twice
its size for assembly-copy headroom. At capacity, peers finish already-admitted
pieces instead of opening more; writes completing automatically resume requests.
This is backpressure, not a fixed network-speed cap. Inactive, stalled partial
pieces without outstanding requests are discarded after 30 seconds so they
cannot permanently exhaust the budget. Hashing and pending writes are never
evicted or prematurely unaccounted on torrent destruction.

The setting must be a positive safe integer (bytes). A piece larger than half
the configured budget is admitted **alone**, so the effective capacity is the
larger of the configured value and twice that piece's size. This is not a total
RSS/container limit: caches, HTTP/peer buffers and kernel filesystem cache are
separate. Keep the container memory limit in place.

HTTP web seeds are read with an exact requested-byte limit instead of buffering
an arbitrary full response. Oversized, short or range-ignoring responses fail
explicitly, and torrent destruction aborts outstanding HTTP requests.

Streaming while downloading and seeking still wait for verified pieces. Serving
an incomplete, preallocated file directly could return zero-filled holes and
would not fix buffering in the background downloader. Completed local files
can still use the existing file-stream route. Background downloading, retained
files and seed lifetimes are unchanged. The app refuses to start if its
WebTorrent patch is absent: install using pnpm and the committed lockfile.

### exFAT and stalled writes

On a non-sparse filesystem such as exFAT, writing a torrent's final piece first
can allocate/zero the entire gap in a large movie. The captured incident had
approximately 62 MiB awaiting disk callbacks, including exactly the last piece
of a 13.1 GiB movie, with no partial/hash data or network progress. This supports
a storage stall rather than unbounded download buffers, but does not prove the
USB drive is healthy or remotely confirm the filesystem cause.

`DISK_STORE_MODE=auto` selects `piece-files` on Linux kernel exFAT mounts and
`direct` elsewhere. Set **`DISK_STORE_MODE=piece-files` explicitly on your exFAT
server**, especially if using FUSE or mount detection is uncertain. Invalid
values fail startup. Sparse-capable filesystems can retain `direct` mode.

The piece-file backend stores out-of-order chunks in small private
`.stremio-pieces-<hash>` directories. Streaming/seeking reads those verified
chunks without extending the movie to a distant offset. Once downloading
finishes, one materialization job at a time writes the normal movie files in
ascending order and reclaims each chunk after saving progress. Spool writes and
movie-copy writes are flushed to disk before completion, so callbacks do not
simply move a large backlog into dirty filesystem cache. Network intake follows
real storage throughput; there is no new configured network-speed cap.

Expect roughly one torrent's disk space plus a piece during materialization for
new downloads; importing/repairing existing files can require additional space.
Keep the private directories and `.stremio-incomplete` sidecars for resume.
Sidecars prevent incomplete materialized prefixes from being served through the
direct-file route. Interrupted materialization resumes using saved progress and
verified data, including kept torrent metadata after seed metadata expires.
Existing completed direct-store files remain supported. Folder deletion waits
for storage operations to stop before removing data.

The stats page shows the actual disk backend, materialization progress/errors,
and the oldest pending disk-write age. Backpressure is an allocation reservation,
**not a file lock**. It must not be force-cleared while an actual write remains
pending. Physical I/O failures, insufficient disk space, or a failing USB drive
still require storage repair. Clean filesystem cache may grow and is reclaimable;
these changes are not a promise of flat Docker/host memory.

Deploying new code cannot cancel a kernel write already allocating a huge gap.
Do not erase retained downloads or force-unmount a busy drive. Check host disk
errors/writeback and restart the application safely once storage is responsive.

For diagnosis, `GET /data/stats` includes `memory` from Node's
`process.memoryUsage()`, the installed `webtorrentVersion`, the configured
`storeCacheSlots`, and `pieceLength` for each active torrent. The `/stats` page
also displays `downloadBudget`: reserved capacity, partial data, hashing,
pending disk callbacks and the number of torrents waiting for capacity.
These pipeline counters are not additional process-memory measurements.
After deployment, the Download Backpressure section must show numeric counters,
not "Backend update required", even though the WebTorrent version is unchanged.
The page also displays process memory, the WebTorrent version, the cache setting,
and per-torrent piece sizes and estimated cache upper bounds (not current cache
allocations or total memory limits). Memory and piece-size API values are in
bytes. Compare `rss` (process resident memory), `heapUsed`, and `arrayBuffers`
(including torrent buffers) while a download runs. `arrayBuffers` is included in
`external`; do not add them together. Docker/host memory can also include
filesystem cache and other charges that are not Node's heap.

If the server becomes unresponsive, check the deployed container's actual limit
and OOM state:

```sh
docker inspect --format 'limit={{.HostConfig.Memory}} OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}}' stremio-torrent
docker stats --no-stream stremio-torrent
curl http://localhost:58827/data/stats
```

A 2 GiB limit should report `2147483648`, not `0` (unlimited). A reservation is not
a hard limit. If process memory stays stable while the host stalls, investigate
disk latency, dirty-page/writeback pressure, swap, and host OOM logs. Stable RSS
does not rule out growing allocations when anonymous memory is being swapped.
Temporarily
reducing `DOWNLOAD_SPEED_LIMIT` to `8388608` (8 MiB/s) can help determine whether
the download is overwhelming the storage device. Larger Node heap limits do not
fix buffer or filesystem-cache pressure.

Source changes do not update an already-running image. To build locally with the
pnpm version matching the v9 lockfile:

```sh
docker build -t stremio-torrent-stream:memory-fix .
```

Set your service's `image` to `stremio-torrent-stream:memory-fix` and recreate it
with `docker compose up -d --force-recreate stremio-addon-server`, preserving your
existing data volume and environment settings.

For the focused regression tests, run `pnpm build` then `pnpm test` with Node
22.12 or later. Tests use synthetic data, not public torrents.
They cover real localhost peer transfers with delayed storage writes and verify
that queued filesystem writes do not duplicate piece payloads.
