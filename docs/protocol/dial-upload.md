# FitPro dial upload (WatchTheme3 / module `0x1F`)

BJ-1 and related LJ733 SuperBand badges **do not** implement Baji media/file transfer (`productId 0x25`). Picture push in the Android app uses the FitPro **watch-theme** path (`WatchTheme3Tools` / `qm2`).

Sending Baji `MEDIA_*` or `FILE_TRANSFER` frames to these devices often times out and can **drop the GATT link**.

## Detection

| Probe | BJ-1 / FitPro-only | Baji badge |
|-------|--------------------|------------|
| GAP name `BJ*` / `DG*` / `BG*` / `*BadgeOK*` | treat as FitPro immediately | — |
| Legacy pair `CD … 12 01 0A …` | `0xDC` ack | often `0xDC` too |
| Legacy `0x1A` D(10)/D(12)/D(28) | best-effort handshake | same |
| Baji `DEVICE_INFO_REQUEST` | **skip** on BJ/DG (timeout only) | `DEVICE_INFO_RESPONSE` |
| FitPro dial info `CD … 20 01 02` | **do not auto-send** — drops BJ-1 GATT | may answer |

The manager uses the GAP name heuristic for SuperBand badges, sends legacy `0x1A` probes, and never auto-sends Baji media or dial-info on those devices.

## Framing

Same `0xCD` start marker as Baji; offset 3 is a **module key**, not `0x25`:

```
CD | lenBE | module | 0x01 | cmd | payloadLenBE | payload
```

| Module | Role |
|--------|------|
| `0x1F` (31) | Dial data plane |
| `0x20` (32) | Dial info / upgrade status |

### Dial info (`0x20` / cmd `2`)

Request: `CD 00 05 20 01 02 00 00` (8-byte short frame).

Response payload (parsed like SDK `bluetooth/c.java` `C()`): screen type, grade, **width/height** BE, model strings, **algorithm**, optional `watchThemeShortPkgLenght` (chunk size hint).

| Algorithm | App encode | Dial type byte |
|-----------|------------|----------------|
| `4` | JPEG (TurboJPEG q≈50, **4:4:4**) | `2` |
| `0` / `3` / other | JieLi `BmpConvert` → RGB565 (packed or raw) | `0` |

BJ-1 / DG01 (AC707N) dial-info is **not** auto-probed (GATT drop). The manager therefore defaults to **RGB565 + dial type `0`**, matching the working `dg01-ble upload-dial` path and non-JPEG FitPro devices. JPEG type `2` is used only when dial-info reports algorithm `4`.

### Upgrade status (`0x20` / cmd `1`)

Request polls; response payload is **u32BE status**:

| Code | Meaning (Android `WatchThemeTransferManager`) |
|------|---------|
| `1000` | Start accepted — send chunk seq 1 |
| `1000 + n` | Chunk `n` accepted — send next (or finish) |
| `100000000 + N` | **Out of storage** — band `{1e8, 2e8}`, value `<1><0><freeBytes>`; SDK maps to `ERROR_MEMORY_LESS` (1010) with `N` bytes available |
| `2` | Upgrade success |
| `1` | Verification failed |
| `3` | Battery too low |
| `4` | **Charging** — firmware rejects dial upgrade while powered |
| `5` | Insufficient storage |
| `6` | Theme count limit exceeded |
| `7` | Duplicate upgrade |
| `8` | Theme id not found |
| `9` | Upgrade too frequent |

> The `1000…` and `100000000…` bands are the ones the badge actually uses during an upload; the `1`–`9` codes arrive as terminal results. Observed on `BG02`: a video whose blob exceeded free space was refused with `06 01 E4 AC` = `100786348` = "1010, **786 348 B free**".

### Managing stored faces / videos (read + delete)

| Op | Frame | Notes |
|----|-------|-------|
| List | `CD 00 05 20 01 03 00 00` (`0x20`/`3`) | reply layout not fully documented — treat as raw |
| Free space | `CD 00 05 20 01 04 00 00` (`0x20`/`4`) | reply = byte count (u64 BE) |
| Delete | `CD 00 09 1F 01 04 00 04 <id u32BE>` (`0x1F`/`4`) | id = watch/dial id (e.g. `5538` = `00 00 15 A2`). **No-op on `BG02`** — see below |
| Switch | `CD 00 09 1F 01 05 00 04 <id u32BE>` (`0x1F`/`5`) | make a stored dial active |
| Factory reset | `CD 00 02 1D 01` | **reboots only** — does not clear stored dials, frees nothing |

Delete over `0xCD` is accepted but ignored on this firmware: the byte-identical SDK frame (`WatchThemeTransferManager`) and the factory reset both leave the stored dial untouched and free space unchanged. Stored faces are owned by JieLi's **RCSP** watch-resource layer (`AE00`), not the `0xCD` dial path, so freeing space must go through the badge itself.

**Reclaim via the badge UI:** the badge's on-device menu has a **trashcan** entry that deletes the **currently displayed** image/video/GIF. Verified on `BG02`: after deleting, the free-space query (`0x20`/`4`) rose from `28 672` → `413 696` bytes (~385 KB reclaimed). So the space accounting is real; the `0xCD` link simply cannot trigger a delete.

There is **no documented read-back of the stored image/video bytes** on the FitPro path — the dial protocol is write-oriented. (Asset download exists only on the Baji `0x02` module, which these badges don't implement.) The manager exposes list/delete/switch in the **Faces / videos on the badge** panel.

The badge also exposes JieLi **RCSP** (`0000ae00`, write `ae01` / notify `ae02`), the transport the app uses for watch resources. Its *external-flash* command (id `26`) has delete (`op 5`), file-info (`op 11`), read (`op 1`) and left-space (`op 12`) ops — a candidate path for listing and downloading stored faces. On `BG02` the RCSP session was probed with no reply; see `src/js/rcsp.js`.

## Payload formats

### RGB565 (default for BJ-1 / DG01)

1. Cover-crop to dial width×height (round mask optional).
2. Pack pixels as **little-endian RGB565** (`R5 G6 B5`), row-major → `width × height × 2` bytes (360×360 → **259200**).
3. File blob: `u32BE(imageLen) ‖ rgb565Bytes`.
4. Start with **dialType `0`**.

Transfer can return status `2` for a wrong encode (e.g. JPEG as type `2` on a type-`0` device) while the screen stays **black**. Prefer RGB565 unless algorithm `4` is known.

### JPEG rules (algorithm `4` only)

Firmware / app `JpegRulesChecker` (+ TurboJPEG `subsample=0`) require:

| Rule | Requirement |
|------|-------------|
| Baseline | SOF0 (`FFC0`), not progressive |
| JFIF | APP0 `JFIF` present |
| Chroma | **4:4:4** (component sampling `0x11` for Y/Cb/Cr) — not browser 4:2:0 |
| MCU | Width/height multiple of **8** (4:4:4). 360×360 fails MCU under 4:2:0 (`%16`) |
| Extra | No ICC APP2 / restart markers preferred |

Browser `canvas.toBlob('image/jpeg')` typically emits **4:2:0 + ICC**. Use `src/js/jpeg444.js` when algorithm is `4`.

### MJPG AVI (video / GIF)

The Android app pushes video/GIF as a **looping MJPG AVI** through the *same* dial path — `WatchTheme3Body.setFileType(1)` (`VideoPushViewModel.uploadVideoWithWatchTheme` → `WatchThemeTransferManager.buildWatchTheme3BodyForVideo`). GIF/MP4/MOV/WMV/FLV/MKV are re-encoded to AVI first (`com.jieli.lib.video.tool.VideoTool`, FFmpegKit) before upload.

| Field | Value |
|-------|-------|
| Start `dialType` byte | **`1`** = AVI (vs `0` RGB565 / `2` JPEG) |
| dialId | **`5538`** — the *same* id the app uses for picture push (`R2.styleable.KeyTrigger_triggerId`) |
| File blob | identical wrapper: `u32BE(aviLen) ‖ aviBytes` |
| Sequence | identical `start(2) → data(1) → finish(3)` (chunk ACK flow unchanged) |

Container is a standard **RIFF/AVI**, `vids`/`MJPG`: an `avih` main header, `strl` (`strh` handler `MJPG` + `strf` BITMAPINFOHEADER), a `movi` list of `00dc` chunks (one raw JPEG each), and an `idx1` index. `src/js/avi.js` builds it from decoded frames; `src/js/video.js` decodes GIF/WebP/APNG (`ImageDecoder`) and video (`<video>` + canvas) into JPEG frames.

The badge CPU is a **JieLi AC7076** ("7076 low power") — the same e-badge class as `samascience/ebadge` (BW03 / AC7076A) and the E01 units, whose firmware accepts **baseline JFIF stills or MJPEG-in-AVI**. That corroborates the container choice.

**Storage is the practical limit:** these badges often have little dial space free, and a dial that exceeds it is **refused at the start** with the `1e8`-band status (no `1000` ACK). The exact free space can be queried with **`0x20`/cmd `4`** (`getDialWatchRemainSpace` → `CD 00 05 20 01 04 00 00`; reply is the byte count). The manager queries it before a video push, clamps its *size budget* to it, and auto-tunes JPEG quality then frame rate (`fitAvi`). On `BG02`, four refusals decoded to a **~106 KB** free figure that barely moved — i.e. the badge was nearly full, and the "free" byte count in the status is unreliable (it tracks the file size), so the explicit `0x20`/`4` query is preferred.

Whether the badge firmware *plays* an AVI dial is the open question: the protocol slots and the app code path exist, but it has not yet been confirmed on hardware.

Badge capacity (AliExpress listing for the LJ733 / `BG02`): 1.5″ **240×240** panel, **≈50 images**, **3 videos (each under 5 s)** and GIFs. Exceeding the video slots is expected to surface as the firmware's **status 6** ("theme count limit exceeded").

## Upload sequence (custom background)

Matches SuperBand `PicturePush` → `WatchThemeTransferManager` → `gh3` for a single custom background:

1. Build file blob: `u32BE(imageLen) ‖ imageBytes` (RGB565 or JPEG)
2. **Start** `0x1F` / cmd `2` with payload:
   - `u32BE dialId` — app uses **`5538`** for processed picture push (and for video)
   - `u8 dialType` — `0` RGB565 / `1` AVI video / `2` JPEG
   - `u8 flags` — `0x08` = custom-background only (bit pack from SDK `ks1.a`)
   - `RGB` 3 bytes (usually `00 00 00`)
   - `u32BE fileSize` — blob length
   - style trailer `00 00 00 00` when no mix styles
3. Wait status **`1000`** (strict — fail on 15 s timeout)
4. **Data** `0x1F` / cmd `1`: `u16BE seq` ‖ chunk ‖ `u32BE byteSum(seq‖chunk)`  
   Seq is **1-based**. Android uses `shortPkg||5000` and may ATT-stream one large CD frame. **Web Bluetooth sends each CD frame in a single GATT write** (splitting mid-frame caused BJ-1 to ACK then show a **black** dial). Chunk = `min(shortPkg||5000, maxWrite−14)` ≈ **498 B** at MTU 512, with **6 ms** pacing.
5. After each chunk, wait status **`1000 + seq`** (strict). On slow ACK, poll `0x20`/cmd `1` (not dial-info cmd `2`).
6. **Finish** `0x1F` / cmd `3`: `u32BE byteSum(entire blob)`
7. Wait status **`2`**

RGB565 ~259 KB ≈ **520** chunks at 498 B (faster than the old 180 B path, image-correct unlike fragmented 5 KB frames).

## Web client

| Module | Role |
|--------|------|
| `src/js/fitpro.js` | FitPro builders + dial-info parse |
| `src/js/client.js` | `transferDialFile()` when `protocolMode !== 'baji'` |
| `src/js/avi.js` | MJPG AVI (RIFF) container builder for video dials |
| `src/js/video.js` | GIF/WebP/APNG + video → JPEG frames |

## Related

- [Framing](framing.md)
- [System info](system-info.md) (Baji probe behavior)
- [Web console](../web-console.md)
- [Firmware hardware](firmware-hw.md)
- [Firmware contract](firmware-contract.md) (clean-room open FW target)
- [Dial-info capture](../firmware-rewrite/dial-info-capture.md)
