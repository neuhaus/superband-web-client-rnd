import { SuperBandBle } from './ble.js';
import {
  Module,
  FileCmd,
  MediaCmd,
  SysCmd,
  FileType,
  FunctionType,
  PROTOCOL,
  ErrorCode,
  buildDeviceInfoRequest,
  buildMediaIdRequest,
  buildMediaListRequest,
  buildMediaDelete,
  buildTransferStart,
  buildFileData,
  buildTransferComplete,
  buildVerificationRequest,
  buildTransferStop,
  buildStatusQuery,
  buildPairingFrame,
  crc32,
  parseDeviceInfo,
  parseMediaIdResponse,
  parseAck,
  parseNack,
} from './protocol.js';
import {
  FitPro,
  buildDialInfoRequest,
  buildDialStatusRequest,
  buildDialStart,
  buildDialStartPayload,
  buildDialDataChunk,
  buildDialFinish,
  buildDialFileBlob,
  parseDialInfo,
  parseDialStatusCode,
  formatDialUpgradeError,
  isFitProDialInfoPacket,
  isFitProDialStatusPacket,
  describeFitProDial,
  dialChunkSize,
  fitproByteSum,
  looksLikeFitProBadge,
  buildLegacyProbe,
} from './fitpro.js';
import {
  PREVIEW,
  buildPreviewStart,
  buildPreviewEndResponse,
  buildPreviewStop,
  buildPreviewFrame,
  isPreviewStartResponse,
  isPreviewEndCommand,
  parsePreviewStartResponse,
} from './preview.js';
import {
  buildSyncTime,
  buildFindDevice,
  buildSetStepTarget,
  buildSetUserInfo,
  buildSetLanguage,
  buildDisturbSwitch,
  buildRealtimeStep,
  buildTakePhoto,
  buildDeviceControl,
  buildEnterOtaMode,
  buildShutdown,
  buildDeviceReset,
} from './commands.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One connected badge (GATT session + Baji / FitPro waiters).
 * Web Bluetooth allows several concurrent GATT connections; each needs its own
 * `requestDevice()` user gesture.
 */
class BadgeSession {
  constructor(hub) {
    this.hub = hub;
    this.id = null;
    this.ble = null;
    this.deviceInfo = null;
    this.disInfo = null;
    this.battery = null;
    this.mediaId = null;
    this.mediaList = null;
    /** @type {'unknown'|'baji'|'fitpro'} */
    this.protocolMode = 'unknown';
    this.dialInfo = null;
    this._fileId = 1n;
    this._waiters = new Map();
    this._transferring = false;
    /** Live viewfinder (product 0x27) state. */
    this.previewActive = false;
    this.previewDims = null;
    this._previewEnded = false;
  }

  get connected() {
    return !!this.ble?.connected;
  }

  get name() {
    return this.ble?.device?.name || this.deviceInfo?.name || null;
  }

  /** True when Baji media/file modules are available. */
  get supportsBajiMedia() {
    return this.protocolMode === 'baji';
  }

  /** True when the session is doing heavy work (file transfer or live preview). */
  get busy() {
    return this._transferring || this.previewActive;
  }

  getSnapshot() {
    const dis = this.disInfo || {};
    const baji = this.deviceInfo || {};
    const dial = this.dialInfo || {};
    return {
      sessionId: this.id,
      connected: this.connected,
      name: this.name,
      model: dis.model || baji.name || dial.mchModel || null,
      firmware: dis.firmware || baji.deviceVersion || null,
      hardware: dis.hardware || null,
      software: dis.software || null,
      manufacturer: dis.manufacturer || null,
      serial: dis.serial || null,
      protocol:
        baji.protocolVersion ||
        (this.protocolMode === 'fitpro' ? 'FitPro dial31' : this.protocolMode === 'baji' ? 'Baji' : null),
      protocolMode: this.protocolMode,
      battery: this.battery,
      freeStorage: baji.freeStorage ?? null,
      storageCapacity: baji.storageCapacity ?? null,
      maxFileSize: baji.maxFileSize ?? null,
      features: baji.features || null,
      mediaId: this.mediaId,
      dialWidth: dial.width ?? null,
      dialHeight: dial.height ?? null,
      dialAlgorithm: dial.algorithm ?? null,
      transferring: this._transferring,
      previewing: this.previewActive,
      previewWidth: this.previewDims?.width ?? null,
      previewHeight: this.previewDims?.height ?? null,
    };
  }

  summary() {
    const snap = this.getSnapshot();
    return {
      id: this.id,
      name: snap.name,
      model: snap.model,
      firmware: snap.firmware,
      battery: snap.battery,
      connected: snap.connected,
      active: this.hub.activeId === this.id,
      transferring: this._transferring,
    };
  }

  _emit(type, detail = {}) {
    this.hub._emit(type, { ...detail, sessionId: this.id });
  }

  _log(msg, level = 'info') {
    const tag = this.name || this.id || 'badge';
    this._emit('log', { msg: `[${tag}] ${msg}`, level, ts: Date.now() });
  }

  _waitFor(predicate, { timeoutMs = 15000, label = 'response' } = {}) {
    return new Promise((resolve, reject) => {
      const id = Symbol(label);
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      this._waiters.set(id, {
        predicate,
        resolve: (pkt) => {
          clearTimeout(timer);
          this._waiters.delete(id);
          resolve(pkt);
        },
      });
    });
  }

  _onPacket(pkt) {
    this._emit('packet', { packet: pkt });

    if (isPreviewEndCommand(pkt)) {
      this._previewEnded = true;
      this._emit('preview', {
        phase: 'device-end',
        status: pkt.payload && pkt.payload.length ? pkt.payload[0] : null,
      });
    }

    if (pkt.moduleId === Module.SYSTEM && pkt.commandId === SysCmd.DEVICE_INFO_RESPONSE) {
      const info = parseDeviceInfo(pkt.payload);
      if (info) {
        this.deviceInfo = info;
        this._emit('deviceinfo', { info });
      }
    }

    if (pkt.moduleId === Module.MEDIA && pkt.commandId === MediaCmd.ID_RESPONSE) {
      const r = parseMediaIdResponse(pkt.payload);
      if (r?.success) {
        this.mediaId = Number(r.mediaId);
        this._emit('mediaid', { mediaId: this.mediaId, message: r.message });
      }
    }

    for (const [, w] of this._waiters) {
      if (w.predicate(pkt)) {
        w.resolve(pkt);
        break;
      }
    }
  }

  async connect({ acceptAll = false } = {}) {
    this.ble = new SuperBandBle({
      onLog: ({ msg, level }) => this._log(msg, level),
      onPacket: (pkt) => this._onPacket(pkt),
      onConnectionChange: (on, meta = {}) => {
        if (meta.id) this.id = meta.id;
        if (!on) {
          this.deviceInfo = null;
          this.disInfo = null;
          this.battery = null;
          this.mediaId = null;
          this.mediaList = null;
          this.dialInfo = null;
          this.protocolMode = 'unknown';
          // Only drop the hub entry if this object still owns that id
          // (avoids wiping an existing session when a duplicate picker result is discarded).
          this.hub._onSessionLost(this.id, this);
          return;
        }
        this.hub._emitSessions();
        if (this.hub.activeId === this.id) {
          this.hub._emit('connection', {
            connected: this.hub.connected,
            name: this.hub.name,
            sessionId: this.id,
          });
          this.hub._emitSnapshot();
        }
      },
    });

    await this.ble.connect({ acceptAll });
    this.id = this.ble.device?.id || `session-${Date.now()}`;
    await this.refreshIdentity();
    return this;
  }

  async refreshIdentity() {
    this.battery = await this.ble.readBattery();
    if (this.battery != null) this._emit('battery', { level: this.battery });

    this.disInfo = await this.ble.readDeviceInformation();
    this._emit('disinfo', { info: this.disInfo });
    this.hub._emitSnapshot();

    // BJ-1 / DG01: Baji DEVICE_INFO times out; DIAL_INFO (0x20) often drops GATT.
    // Match the Android post-connect path: legacy 0x1A probes, then FitPro dial31 for push.
    if (looksLikeFitProBadge(this.name)) {
      this.protocolMode = 'fitpro';
      this._log('Protocol: FitPro dial31 (GAP name heuristic — skipping Baji / dial-info probes)', 'ok');
      await this._fitProHandshake();
      this.hub._emitSnapshot();
      return this.getSnapshot();
    }

    try {
      await this.refreshDeviceInfo({ timeoutMs: 6000 });
      this.protocolMode = 'baji';
      this._log('Protocol: Baji (media/file modules)', 'ok');
    } catch (e) {
      this.protocolMode = 'fitpro';
      this._log(
        `Baji device info unavailable (${e.message}) — FitPro dial path (no dial-info probe)`,
        'warn',
      );
      if (this.connected) await this._fitProHandshake();
    }
    this.hub._emitSnapshot();
    return this.getSnapshot();
  }

  /**
   * Android zl.java after DeviceFunctionEvent: D(10), D(12), capability D(28).
   * Best-effort — ignore failures; do not query dial info (crashes BJ-1).
   */
  async fitProHandshake() {
    if (!this.connected) return;
    const cmds = [
      [FitPro.LegacyCmd.PROBE_A, 'LEGACY_1A/10'],
      [FitPro.LegacyCmd.PROBE_B, 'LEGACY_1A/12'],
      [FitPro.LegacyCmd.CAPABILITY, 'LEGACY_1A/28'],
    ];
    for (const [cmd, label] of cmds) {
      if (!this.connected) break;
      try {
        await this.write(buildLegacyProbe(cmd), label);
        await sleep(120);
      } catch (e) {
        this._log(`${label} failed: ${e.message}`, 'warn');
        break;
      }
    }
  }

  /** @deprecated use fitProHandshake */
  async _fitProHandshake() {
    return this.fitProHandshake();
  }

  async disconnect() {
    await this.ble?.disconnect();
    this.ble = null;
  }

  async write(bytes, label, opts) {
    if (!this.connected) throw new Error('Not connected');
    return this.ble.write(bytes, label, opts);
  }

  async refreshDeviceInfo({ timeoutMs = 10000 } = {}) {
    await this.write(buildDeviceInfoRequest(), 'DEVICE_INFO_REQUEST');
    const pkt = await this._waitFor(
      (p) => p.moduleId === Module.SYSTEM && p.commandId === SysCmd.DEVICE_INFO_RESPONSE,
      { timeoutMs, label: 'DEVICE_INFO_RESPONSE' },
    );
    const info = parseDeviceInfo(pkt.payload);
    this.deviceInfo = info;
    this._emit('deviceinfo', { info });
    this.hub._emitSnapshot();
    return info;
  }

  async pair() {
    await this.write(buildPairingFrame(), 'legacy pair');
  }

  async allocateMediaId({ timeoutMs = 30000 } = {}) {
    if (!this.supportsBajiMedia) {
      throw new Error('Media ID is Baji-only; this badge uses FitPro dial push');
    }
    await this.write(buildMediaIdRequest(), 'MEDIA_ID_REQUEST');
    const pkt = await this._waitFor(
      (p) => p.moduleId === Module.MEDIA && p.commandId === MediaCmd.ID_RESPONSE,
      { timeoutMs, label: 'MEDIA_ID_RESPONSE' },
    );
    const r = parseMediaIdResponse(pkt.payload);
    if (!r?.success) throw new Error(r?.message || 'Media ID allocation failed');
    this.mediaId = Number(r.mediaId);
    this._emit('mediaid', { mediaId: this.mediaId, message: r.message });
    this.hub._emitSnapshot();
    return this.mediaId;
  }

  async requestMediaList({ timeoutMs = 15000 } = {}) {
    if (!this.supportsBajiMedia) {
      this._log('Skip MEDIA_LIST — FitPro badge (Baji media disconnects BJ-1)', 'warn');
      return [];
    }
    await this.write(buildMediaListRequest(), 'MEDIA_LIST_REQUEST');
    const pkt = await this._waitFor(
      (p) => p.moduleId === Module.MEDIA && p.commandId === MediaCmd.LIST_RESPONSE,
      { timeoutMs, label: 'MEDIA_LIST_RESPONSE' },
    );
    const items = parseMediaList(pkt.payload);
    this.mediaList = items;
    this._emit('medialist', { items, raw: pkt.payload });
    return items;
  }

  async deleteMedia(mediaId, { timeoutMs = 15000 } = {}) {
    if (!this.supportsBajiMedia) {
      throw new Error('Media delete is Baji-only on this badge');
    }
    await this.write(buildMediaDelete(mediaId), 'MEDIA_DELETE');
    try {
      const pkt = await this._waitFor(
        (p) => p.moduleId === Module.MEDIA && p.commandId === MediaCmd.DELETE,
        { timeoutMs, label: 'MEDIA_DELETE response' },
      );
      return pkt;
    } catch {
      return null;
    }
  }

  async refreshDialInfo({ timeoutMs = 8000 } = {}) {
    await this.write(buildDialInfoRequest(), 'DIAL_INFO_REQUEST');
    const pkt = await this._waitFor((p) => isFitProDialInfoPacket(p), {
      timeoutMs,
      label: 'DIAL_INFO_RESPONSE',
    });
    const info = parseDialInfo(pkt.payload);
    if (!info) throw new Error('Could not parse dial info');
    this.dialInfo = info;
    this._log(`Dial info: ${describeFitProDial(info)}`, 'ok');
    this._emit('dialinfo', { info });
    this.hub._emitSnapshot();
    return info;
  }

  /**
   * Wait for dial status code — mirrors WatchTheme3Tools (`gh3`):
   * listen for notify; after ~5s / when remaining ≤ 10s, poll `0x20`/cmd `1`
   * (status poll, not dial-info — Android does this on countdown ticks).
   */
  async _waitDialStatus(
    expectedCode,
    {
      timeoutMs = FitPro.ACK_TIMEOUT_MS,
      label = 'DIAL_STATUS',
      poll = true,
    } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let nextPollAt = Date.now() + FitPro.ACK_TICK_MS;
    while (Date.now() < deadline) {
      if (!this.connected) throw new Error('Disconnected while waiting for dial status');
      const remain = deadline - Date.now();
      const slice = Math.min(FitPro.ACK_TICK_MS, Math.max(50, remain));
      const pending = this._waitFor(
        (p) => isFitProDialStatusPacket(p) && parseDialStatusCode(p.payload) != null,
        { timeoutMs: slice, label },
      );
      // Android: countdown tick when remaining ≤ 10s → qm2.h() status poll.
      const shouldPoll =
        poll && Date.now() >= nextPollAt && remain <= FitPro.ACK_POLL_REMAINING_MS;
      if (shouldPoll) {
        nextPollAt = Date.now() + FitPro.ACK_TICK_MS;
        this.write(buildDialStatusRequest(), 'DIAL_STATUS_POLL', {
          paceMs: FitPro.COMMAND_POOL_MS,
          quiet: true,
        }).catch(() => {});
      }
      try {
        const pkt = await pending;
        const code = parseDialStatusCode(pkt.payload);
        if (code === expectedCode) return pkt;
        if (code >= 1 && code <= 9) {
          throw new Error(formatDialUpgradeError(code));
        }
        // Other codes in 1000+ band for a different seq — keep waiting.
      } catch (e) {
        if (String(e.message || '').startsWith('Dial upgrade error')) throw e;
        if (String(e.message || '').includes('Disconnected')) throw e;
        // slice timeout — loop until deadline
      }
    }
    throw new Error(`Timeout waiting for ${label} (code ${expectedCode})`);
  }

  async queryTransferStatus() {
    await this.write(buildStatusQuery(), 'STATUS');
  }

  async transferFile(
    fileBytes,
    {
      fileType = FileType.IMAGE,
      functionType = FunctionType.BACKGROUND,
      mediaId = null,
      allocateId = true,
      onProgress = null,
    } = {},
  ) {
    if (this.previewActive) throw new Error('Live preview is running — stop it before pushing');
    if (this.protocolMode !== 'baji') {
      return this.transferDialFile(fileBytes, { onProgress });
    }

    if (this._transferring) throw new Error('Transfer already in progress on this badge');
    this._transferring = true;
    this.hub._emitSessions();

    try {
      let mid = mediaId ?? this.mediaId;
      if (mid == null || allocateId) {
        mid = await this.allocateMediaId();
      }

      const localFileId = this._fileId++;
      const checksum = crc32(fileBytes);
      this._log(
        `Transfer size=${fileBytes.length} crc=0x${checksum.toString(16)} mediaId=${mid}`,
        'info',
      );
      this._emit('transfer', { phase: 'start', mediaId: mid, size: fileBytes.length, checksum });

      await this.write(
        buildTransferStart({
          fileSize: fileBytes.length,
          fileType,
          functionType,
          mediaId: mid,
        }),
        'TRANSFER_START',
      );

      const ackPkt = await this._waitFor(
        (p) =>
          p.moduleId === Module.FILE_TRANSFER &&
          (p.commandId === FileCmd.TRANSFER_ACK || p.commandId === FileCmd.TRANSFER_NACK),
        { timeoutMs: 30000, label: 'TRANSFER_ACK' },
      );

      if (ackPkt.commandId === FileCmd.TRANSFER_NACK) {
        const n = parseNack(ackPkt.payload);
        const name = ErrorCode[n?.errorCode] || n?.errorCode;
        throw new Error(`Transfer NACK: ${name} ${n?.message || ''}`);
      }

      const ack = parseAck(ackPkt.payload);
      const fileId = ack?.fileId != null ? ack.fileId : localFileId;

      const chunkSize = PROTOCOL.MAX_CHUNK;
      const totalChunks = Math.max(1, Math.ceil(fileBytes.length / chunkSize));

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, fileBytes.length);
        const slice = fileBytes.slice(start, end);
        await this.write(
          buildFileData({
            fileId,
            chunkIndex: i,
            data: slice,
            isLast: end >= fileBytes.length,
          }),
          `FILE_DATA[${i}]`,
        );
        const pct = Math.round(((i + 1) / totalChunks) * 92);
        onProgress?.(pct, i + 1, totalChunks);
        this._emit('transfer', { phase: 'chunk', index: i, total: totalChunks, percent: pct });

        await Promise.race([
          this._waitFor(
            (p) =>
              p.moduleId === Module.FILE_TRANSFER &&
              (p.commandId === FileCmd.NEXT_CHUNK ||
                p.commandId === FileCmd.RETRY ||
                p.commandId === FileCmd.TRANSFER_ACK),
            { timeoutMs: 60, label: 'chunk-flow' },
          ).catch(() => null),
          new Promise((r) => setTimeout(r, 16)),
        ]);
      }

      await this.write(buildTransferComplete(fileId, checksum), 'TRANSFER_COMPLETE');
      await this.write(buildVerificationRequest(fileId), 'VERIFICATION_RESULT');

      let verified = null;
      try {
        const ver = await this._waitFor(
          (p) =>
            p.moduleId === Module.FILE_TRANSFER && p.commandId === FileCmd.VERIFICATION_RESULT,
          { timeoutMs: 30000, label: 'VERIFICATION_RESULT' },
        );
        verified = ver.payload.length >= 9 ? ver.payload[8] === 1 : null;
      } catch (e) {
        this._log(`Verification wait: ${e.message}`, 'warn');
      }

      onProgress?.(100, totalChunks, totalChunks);
      this._emit('transfer', {
        phase: 'complete',
        fileId,
        mediaId: mid,
        checksum,
        verified,
      });
      return { fileId, mediaId: mid, checksum, verified, sessionId: this.id, path: 'baji' };
    } finally {
      this._transferring = false;
      this.hub._emitSessions();
    }
  }

  /**
   * FitPro WatchTheme3 dial31 custom-background upload.
   * Android `gh3` pacing/ACKs; chunk size capped so each CD frame is one GATT write
   * (Web Bluetooth cannot safely stream mid-frame ATT fragments the way the Android stack does).
   */
  async transferDialFile(fileBytes, { onProgress = null } = {}) {
    if (this._transferring) throw new Error('Transfer already in progress on this badge');
    if (this.previewActive) throw new Error('Live preview is running — stop it before pushing');
    if (!this.connected) throw new Error('Not connected');
    this._transferring = true;
    this.hub._emitSessions();
    const writeOpts = { paceMs: FitPro.COMMAND_POOL_MS, quiet: true, atomic: true };
    this.ble?.setQuiet?.(true);

    try {
      // Do not send DIAL_INFO (0x20/2) — drops BJ-1. Default RGB565 + dialType 0.
      const info = this.dialInfo;
      const dialType = info?.dialType ?? (info?.algorithm === 4 ? 2 : 0);
      const expectJpeg = dialType === 2;
      const looksJpeg =
        fileBytes.length >= 3 && fileBytes[0] === 0xff && fileBytes[1] === 0xd8;
      if (expectJpeg && !looksJpeg) {
        throw new Error('Dial algorithm 4 expects JPEG 4:4:4 bytes; re-prepare image');
      }
      if (!expectJpeg && looksJpeg) {
        throw new Error(
          'FitPro badge expects RGB565 (dial type 0), not JPEG — re-select the image after connect',
        );
      }
      const fileBlob = buildDialFileBlob(fileBytes);
      const attMax = this.ble?.maxWriteLength || 512;
      const chunkSize = dialChunkSize(info, attMax);
      const checksum = fitproByteSum(fileBlob);
      const totalChunks = Math.max(1, Math.ceil(fileBlob.length / chunkSize));

      this._log(
        `Dial31 size=${fileBlob.length} img=${fileBytes.length} ` +
          `chunk=${chunkSize} (atomic GATT, attMax=${attMax}) chunks=${totalChunks} ` +
          `type=${dialType} ${expectJpeg ? 'JPEG' : 'RGB565'} pace=${FitPro.COMMAND_POOL_MS}ms`,
        'info',
      );
      this._emit('transfer', {
        phase: 'start',
        mediaId: FitPro.PICTURE_DIAL_ID,
        size: fileBlob.length,
        checksum,
        path: 'fitpro-dial31',
      });
      onProgress?.(2);

      if (this.connected) await this._fitProHandshake();
      await sleep(200);

      const startPayload = buildDialStartPayload({
        dialId: FitPro.PICTURE_DIAL_ID,
        dialType,
        fileSize: fileBlob.length,
      });
      await this.write(buildDialStart(startPayload), 'DIAL_START', writeOpts);
      // gh3: wait status 1000 before first DATA (strict — no soft-continue).
      await this._waitDialStatus(FitPro.STATUS_CHUNK_BASE, {
        timeoutMs: FitPro.ACK_TIMEOUT_MS,
        label: 'DIAL_START_ACK(1000)',
        poll: true,
      });
      onProgress?.(5);

      for (let i = 0; i < totalChunks; i++) {
        if (!this.connected) throw new Error('Disconnected during dial upload');
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, fileBlob.length);
        const slice = fileBlob.subarray
          ? fileBlob.subarray(start, end)
          : fileBlob.slice(start, end);
        const seq = i + 1;
        await this.write(buildDialDataChunk(seq, slice), `DIAL_DATA[${seq}]`, writeOpts);
        await this._waitDialStatus(FitPro.STATUS_CHUNK_BASE + seq, {
          timeoutMs: FitPro.ACK_TIMEOUT_MS,
          label: `DIAL_CHUNK_ACK(${FitPro.STATUS_CHUNK_BASE + seq})`,
          poll: true,
        });
        const pct = 5 + Math.round(((i + 1) / totalChunks) * 90);
        onProgress?.(pct, i + 1, totalChunks);
        this._emit('transfer', { phase: 'chunk', index: i, total: totalChunks, percent: pct });
      }

      await this.write(buildDialFinish(fileBlob), 'DIAL_FINISH', writeOpts);
      await this._waitDialStatus(FitPro.STATUS_OK, {
        timeoutMs: FitPro.ACK_TIMEOUT_MS,
        label: 'DIAL_FINISH_OK(2)',
        poll: true,
      });
      onProgress?.(100, totalChunks, totalChunks);
      this._emit('transfer', {
        phase: 'complete',
        mediaId: FitPro.PICTURE_DIAL_ID,
        checksum,
        verified: true,
        path: 'fitpro-dial31',
      });
      this._log(
        `Dial31 complete ${fileBlob.length}B in ${totalChunks} logical chunks (checksum=${checksum})`,
        'ok',
      );
      return {
        fileId: FitPro.PICTURE_DIAL_ID,
        mediaId: FitPro.PICTURE_DIAL_ID,
        checksum,
        verified: true,
        sessionId: this.id,
        path: 'fitpro-dial31',
      };
    } finally {
      this.ble?.setQuiet?.(false);
      this._transferring = false;
      this.hub._emitSessions();
    }
  }

  // ── Live viewfinder (product 0x27) ────────────────────────────────────────

  /**
   * Send the preview START frame and wait for the device start response.
   * @returns {Promise<{width:number,height:number}>} device display size
   */
  async previewStart({ timeoutMs = 5000 } = {}) {
    if (!this.connected) throw new Error('Not connected');
    if (this.previewActive) throw new Error('Preview already running');
    if (this._transferring) throw new Error('A file transfer is in progress');
    this._previewEnded = false;
    await this.write(buildPreviewStart(), 'PREVIEW_START');
    const pkt = await this._waitFor((p) => isPreviewStartResponse(p), {
      timeoutMs,
      label: 'PREVIEW_START_RESPONSE',
    });
    const r = parsePreviewStartResponse(pkt.payload);
    if (!r) throw new Error('Malformed preview start response');
    if (!r.ok) throw new Error(`Device rejected preview (status ${r.status})`);
    this.previewActive = true;
    this.previewDims = { width: r.width, height: r.height };
    this._log(`Preview started — device display ${r.width}×${r.height}`, 'ok');
    this._emit('preview', { phase: 'started', width: r.width, height: r.height });
    this.hub._emitSessions();
    return this.previewDims;
  }

  /** Push one JPEG frame to the badge display (chunked raw 0xAA…0xAA frame). */
  async previewSendFrame(jpeg, { chunkSize = PREVIEW.DEFAULT_CHUNK, paceMs = 4 } = {}) {
    if (!this.connected) throw new Error('Not connected');
    if (!this.previewActive) throw new Error('Preview not started');
    const frame = buildPreviewFrame(jpeg);
    await this.write(frame, `PREVIEW_FRAME(${jpeg.length}B)`, {
      atomic: false,
      chunkSize,
      paceMs,
      quiet: true,
    });
    this._emit('preview', { phase: 'frame', bytes: jpeg.length });
    return frame.length;
  }

  /** Reply to a device-initiated end command (status 0 = success). */
  async previewRespondEnd(status = PREVIEW.STATUS_SUCCESS) {
    if (!this.connected) return;
    await this.write(buildPreviewEndResponse(status), 'PREVIEW_END_RESPONSE', { quiet: true });
  }

  /** Stop the preview stream (optionally sending an end response first). */
  async previewStop({ respond = false, status = PREVIEW.STATUS_SUCCESS } = {}) {
    const wasActive = this.previewActive;
    this.previewActive = false;
    if (!this.connected) return;
    if (respond) await this.previewRespondEnd(status);
    await this.write(buildPreviewStop(), 'PREVIEW_STOP', { quiet: true });
    if (wasActive) {
      this._log('Preview stopped', 'info');
      this._emit('preview', { phase: 'stopped' });
      this.hub._emitSessions();
    }
  }

  // ── Quick settings / device control (legacy MyWatch frames) ───────────────

  async syncTime(date = new Date()) {
    await this.write(buildSyncTime(date), 'SYNC_TIME');
  }

  async findDevice(on = true) {
    await this.write(buildFindDevice(on), on ? 'FIND_DEVICE_ON' : 'FIND_DEVICE_OFF');
  }

  async setStepTarget(steps) {
    await this.write(buildSetStepTarget(steps), 'SET_STEP_TARGET');
  }

  async setUserInfo(info) {
    await this.write(buildSetUserInfo(info), 'SET_USER_INFO');
  }

  async setLanguage(index) {
    await this.write(buildSetLanguage(index), 'SET_LANGUAGE');
  }

  async setDisturb(on, startHour, endHour) {
    await this.write(buildDisturbSwitch(on, startHour, endHour), 'SET_DISTURB');
  }

  async setRealtimeStep(on) {
    await this.write(buildRealtimeStep(on), 'REALTIME_STEP');
  }

  async takePhoto(on = true) {
    await this.write(buildTakePhoto(on), on ? 'TAKE_PHOTO_ON' : 'TAKE_PHOTO_OFF');
  }

  async deviceControl(key, value = null) {
    await this.write(buildDeviceControl(key, value), `DEV_CTRL_${key}`);
  }

  async enterOtaMode() {
    await this.write(buildEnterOtaMode(), 'ENTER_OTA_MODE');
  }

  async shutdown() {
    await this.write(buildShutdown(), 'SHUTDOWN');
  }

  async deviceReset() {
    await this.write(buildDeviceReset(), 'DEVICE_RESET');
  }

  async stopTransfer() {
    if (this.protocolMode === 'baji') {
      await this.write(buildTransferStop(this._fileId), 'TRANSFER_STOP');
    }
  }
}

/**
 * Multi-badge hub. Each `connect()` opens another Web Bluetooth picker and keeps
 * prior sessions alive. Commands target the active session unless noted.
 */
export class SuperBandClient extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, BadgeSession>} */
    this._sessions = new Map();
    this.activeId = null;
  }

  static supported() {
    return SuperBandBle.supported();
  }

  get sessionCount() {
    return this._sessions.size;
  }

  get connected() {
    return !!this.active?.connected;
  }

  get name() {
    return this.active?.name || null;
  }

  get active() {
    return this.activeId ? this._sessions.get(this.activeId) || null : null;
  }

  get sessions() {
    return [...this._sessions.values()].map((s) => s.summary());
  }

  getSnapshot() {
    return this.active?.getSnapshot() || {
      connected: false,
      name: null,
      model: null,
      firmware: null,
      hardware: null,
      software: null,
      manufacturer: null,
      serial: null,
      protocol: null,
      protocolMode: 'unknown',
      battery: null,
      freeStorage: null,
      storageCapacity: null,
      maxFileSize: null,
      features: null,
      mediaId: null,
      dialWidth: null,
      dialHeight: null,
      dialAlgorithm: null,
      sessionId: null,
      previewing: false,
      previewWidth: null,
      previewHeight: null,
    };
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _emitSnapshot() {
    this._emit('snapshot', { snapshot: this.getSnapshot(), sessionId: this.activeId });
  }

  _emitSessions() {
    this._emit('sessions', {
      sessions: this.sessions,
      activeId: this.activeId,
      count: this.sessionCount,
    });
  }

  _requireActive() {
    const s = this.active;
    if (!s?.connected) throw new Error('No active badge connected');
    return s;
  }

  _onSessionLost(id, session) {
    if (!id) return;
    const cur = this._sessions.get(id);
    if (!cur || (session && cur !== session)) return;
    this._sessions.delete(id);
    if (this.activeId === id) {
      const next = this._sessions.keys().next();
      this.activeId = next.done ? null : next.value;
    }
    this._emitSessions();
    this._emit('connection', {
      connected: this.connected,
      name: this.name,
      sessionId: this.activeId,
    });
    this._emitSnapshot();
  }

  setActive(id) {
    if (!this._sessions.has(id)) throw new Error('Unknown session');
    this.activeId = id;
    this._emitSessions();
    this._emit('connection', {
      connected: this.connected,
      name: this.name,
      sessionId: this.activeId,
    });
    this._emitSnapshot();
    const s = this.active;
    if (s?.mediaList) {
      this._emit('medialist', { items: s.mediaList, sessionId: s.id });
    }
    return s;
  }

  /**
   * Open the Bluetooth picker and add another badge (keeps existing connections).
   * Selecting an already-connected device focuses that session.
   */
  async connect({ acceptAll = false } = {}) {
    const session = new BadgeSession(this);
    await session.connect({ acceptAll });

    const existing = this._sessions.get(session.id);
    if (existing && existing !== session) {
      // Same BluetoothDevice id already connected — do not GATT-disconnect
      // (that would drop the live session sharing this device object).
      this._logReuse(session);
      session.ble?.abandon();
      session.ble = null;
      this.setActive(existing.id);
      return existing;
    }

    if (!session.connected) {
      session.ble?.abandon?.();
      throw new Error(
        `${session.name || 'Badge'} dropped during identity probe — reconnect and retry`,
      );
    }

    this._sessions.set(session.id, session);
    this.activeId = session.id;
    this._emitSessions();
    this._emit('connection', {
      connected: true,
      name: session.name,
      sessionId: session.id,
    });
    this._emitSnapshot();
    this._emit('log', {
      msg: `Session ready: ${session.name || session.id} (${this.sessionCount} connected)`,
      level: 'ok',
      ts: Date.now(),
    });
    return session;
  }

  _logReuse(session) {
    this._emit('log', {
      msg: `${session.name || session.id} already connected — switched to existing session`,
      level: 'info',
      ts: Date.now(),
    });
  }

  async disconnect(id = this.activeId) {
    if (!id) return;
    const s = this._sessions.get(id);
    if (!s) return;
    await s.disconnect();
    this._sessions.delete(id);
    if (this.activeId === id) {
      const next = this._sessions.keys().next();
      this.activeId = next.done ? null : next.value;
    }
    this._emitSessions();
    this._emit('connection', {
      connected: this.connected,
      name: this.name,
      sessionId: this.activeId,
    });
    this._emitSnapshot();
  }

  async disconnectAll() {
    const ids = [...this._sessions.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  async refreshIdentity() {
    return this._requireActive().refreshIdentity();
  }

  async refreshDeviceInfo(opts) {
    return this._requireActive().refreshDeviceInfo(opts);
  }

  async refreshDialInfo(opts) {
    return this._requireActive().refreshDialInfo(opts);
  }

  async fitProHandshake() {
    return this._requireActive().fitProHandshake();
  }

  /** Active session GATT server (for AE00 probe / OTA). */
  getActiveGattServer() {
    const server = this.active?.ble?.gattServer;
    return server?.connected ? server : null;
  }

  async pair() {
    return this._requireActive().pair();
  }

  async write(bytes, label, opts) {
    return this._requireActive().write(bytes, label, opts);
  }

  async allocateMediaId(opts) {
    return this._requireActive().allocateMediaId(opts);
  }

  async requestMediaList(opts) {
    return this._requireActive().requestMediaList(opts);
  }

  async deleteMedia(mediaId, opts) {
    return this._requireActive().deleteMedia(mediaId, opts);
  }

  async queryTransferStatus() {
    return this._requireActive().queryTransferStatus();
  }

  async transferFile(fileBytes, opts) {
    return this._requireActive().transferFile(fileBytes, opts);
  }

  /** True if any connected session is mid-transfer. */
  get anyTransferring() {
    for (const session of this._sessions.values()) {
      if (session.connected && session._transferring) return true;
    }
    return false;
  }

  /**
   * Push the same image to every connected badge in parallel (one GATT write stream each).
   * @param {Uint8Array} fileBytes
   * @param {{ onProgress?: (pct: number, detail?: object) => void } & object} opts
   */
  async transferFileToAll(fileBytes, opts = {}) {
    const { onProgress = null, ...rest } = opts;
    const targets = [...this._sessions.values()].filter((s) => s.connected);
    if (!targets.length) return [];

    const pctById = new Map(targets.map((s) => [s.id, 0]));
    const emitAgg = () => {
      if (!onProgress) return;
      let sum = 0;
      for (const p of pctById.values()) sum += p;
      const overall = Math.round(sum / targets.length);
      const perBadge = targets.map((s) => ({
        sessionId: s.id,
        name: s.name,
        percent: pctById.get(s.id) ?? 0,
      }));
      onProgress(overall, { perBadge });
    };

    this._emitSessions();
    const settled = await Promise.allSettled(
      targets.map((session) =>
        session.transferFile(fileBytes, {
          ...rest,
          onProgress: (pct) => {
            pctById.set(session.id, Number(pct) || 0);
            emitAgg();
          },
        }),
      ),
    );

    const results = settled.map((outcome, i) => {
      const session = targets[i];
      if (outcome.status === 'fulfilled') {
        return { ok: true, ...outcome.value, name: session.name };
      }
      return {
        ok: false,
        error: outcome.reason?.message || String(outcome.reason),
        sessionId: session.id,
        name: session.name,
      };
    });

    this._emitSessions();
    this._emitSnapshot();
    return results;
  }

  // ── Live viewfinder + quick commands (active session) ─────────────────────

  get previewActive() {
    return !!this.active?.previewActive;
  }

  get anyPreviewing() {
    for (const session of this._sessions.values()) {
      if (session.connected && session.previewActive) return true;
    }
    return false;
  }

  async previewStart(opts) {
    return this._requireActive().previewStart(opts);
  }

  async previewSendFrame(jpeg, opts) {
    return this._requireActive().previewSendFrame(jpeg, opts);
  }

  async previewRespondEnd(status) {
    return this._requireActive().previewRespondEnd(status);
  }

  async previewStop(opts) {
    return this._requireActive().previewStop(opts);
  }

  async syncTime(date) {
    return this._requireActive().syncTime(date);
  }

  async findDevice(on) {
    return this._requireActive().findDevice(on);
  }

  async setStepTarget(steps) {
    return this._requireActive().setStepTarget(steps);
  }

  async setUserInfo(info) {
    return this._requireActive().setUserInfo(info);
  }

  async setLanguage(index) {
    return this._requireActive().setLanguage(index);
  }

  async setDisturb(on, startHour, endHour) {
    return this._requireActive().setDisturb(on, startHour, endHour);
  }

  async setRealtimeStep(on) {
    return this._requireActive().setRealtimeStep(on);
  }

  async takePhoto(on) {
    return this._requireActive().takePhoto(on);
  }

  async deviceControl(key, value) {
    return this._requireActive().deviceControl(key, value);
  }

  async enterOtaMode() {
    return this._requireActive().enterOtaMode();
  }

  async shutdown() {
    return this._requireActive().shutdown();
  }

  async deviceReset() {
    return this._requireActive().deviceReset();
  }

  async stopTransfer() {
    return this._requireActive().stopTransfer();
  }
}

/**
 * Best-effort media list parser (device response layout from RnD notes).
 * Returns as many complete records as fit; tolerates truncated tails.
 */
export function parseMediaList(payload) {
  if (!payload?.length) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const items = [];
  let o = 0;
  const decoder = new TextDecoder();

  while (o + 8 + 4 <= payload.length) {
    const start = o;
    try {
      const mediaId = Number(
        (BigInt(view.getUint32(o, false)) << 32n) | BigInt(view.getUint32(o + 4, false)),
      );
      o += 8;
      const nameLen = view.getUint32(o, false);
      o += 4;
      if (nameLen > 1024 || o + nameLen > payload.length) {
        o = start + 1;
        continue;
      }
      const name = decoder.decode(payload.slice(o, o + nameLen));
      o += nameLen;
      if (o + 4 + 1 + 4 + 4 + 4 + 4 + 4 > payload.length) break;
      const fileSize = view.getUint32(o, false);
      o += 4;
      const fileType = payload[o];
      o += 1;
      const checksum = view.getUint32(o, false);
      o += 4;
      const timestamp = view.getUint32(o, false);
      o += 4;
      const previewSize = view.getUint32(o, false);
      o += 4;
      const backgroundSize = view.getUint32(o, false);
      o += 4;
      const metaLen = view.getUint32(o, false);
      o += 4;
      if (metaLen > 4096 || o + metaLen > payload.length) break;
      const metadata = decoder.decode(payload.slice(o, o + metaLen));
      o += metaLen;
      items.push({
        mediaId,
        name,
        fileSize,
        fileType,
        checksum,
        timestamp,
        previewSize,
        backgroundSize,
        metadata,
      });
    } catch {
      break;
    }
  }
  return items;
}

export { FileType, FunctionType, PROTOCOL };
