/**
 * JieLi RCSP session over AE00/AE01/AE02 — auth + filesystem.
 *
 * The badge exposes JieLi RCSP (AE00). Two layers are involved:
 *
 *  1. A 6-step **auth handshake**, RAW over AE01/AE02 (no FE-DC-BA framing).
 *     Until it passes, the badge ignores RCSP commands (see jl-auth.js).
 *  2. Framed RCSP commands: `FE DC BA | flags | cmd | len(BE16) | body | EF`,
 *     where a command body is `sn | [xm |] data` and a response body is
 *     `status | sn | [xm |] data` (mirrors the SDK's ParseHelper).
 *
 * The app's face management is the JieLi "watch resource" API built on this
 * (`WatchDemo.listWatchs` / `readWatch` / `deleteWatch`, and the higher-level
 * file browse used here). Browse + small-file read are ported from qix-ble
 * (which ports the official app's `rcsp_session`/`file_browse`).
 */

import { buildRcspFrame, parseRcspFrame, RcspCmd } from './jieli-ota.js';
import { jliEncrypt, randomAuthData, AUTH_STEP } from './jl-auth.js';
import { toHex } from './protocol.js';

/** RCSP command id for ExternalFlashIOCtrlCmd (com.jieli.jl_rcsp). */
export const RCSP_EXTERNAL_FLASH_CMD = 26;

/** RCSP command ids for the filesystem layer. */
export const RcspFsCmd = {
  GET_TARGET_INFO: 0x03,
  START_FILE_BROWSE: 0x0c,
  STOP_FILE_BROWSE: 0x0d,
  FILE_METADATA: 0x1b,
  SESSION_CLOSE: 0x1c,
  SMALL_FILE_OP: 0x28,
  DATA_PUSH: 0x01,
};

export const RcspFlag = {
  PHONE_REQ: 0xc0, // command from phone, wants response
  DEVICE_RESP: 0x00, // response from device (and phone ACK to a device push)
};

/** Storage device handlers (JieLi): 0=USB 1=SD0 2=SD1 3=Flash. */
export const DeviceHandler = { USB: 0, SD0: 1, SD1: 2, FLASH: 3 };
export const DEVICE_NAMES = ['USB', 'SD0', 'SD1', 'Flash'];

export const ExternalOp = {
  WRITE_DATA: 0,
  GET_LEFT_SPACE: 12,
  GET_FILE_MSG: 11,
  WATCH_OP: 3,
  DELETE_FILE: 5,
  INSERT_FILE: 2,
  ERASE: 4,
};

export const WatchSubOp = {
  CURRENT: 0,
  VERSION: 3,
  ENABLE_CUSTOM_BG: 4,
  CUSTOM_BG_INFO: 5,
};

function u8(...vals) {
  return Uint8Array.from(vals.map((v) => v & 0xff));
}

function u16be(v) {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u16le(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32be(v) {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function encPath(path) {
  return new TextEncoder().encode(path || '');
}

/**
 * Build an ExternalFlashIOCtrl param (post-auth, may work where pre-auth it did not).
 * @param {{op:number, flag?:number, filePath?:string, offset?:number, size?:number}} o
 */
export function buildExternalFlashParam({ op, flag = 0, filePath = null, offset = 0, size = 0 } = {}) {
  const opEnd = (flag & 1) === 0;
  const head = u8(op, flag);
  const path = filePath != null ? encPath(filePath) : null;

  switch (op) {
    case ExternalOp.WATCH_OP:
      if (flag >= 1 && flag <= 5 && path) return concat(head, path);
      return head;
    case ExternalOp.GET_FILE_MSG:
      return path ? concat(head, path) : head;
    case ExternalOp.WRITE_DATA:
      return concat(head, u32be(offset));
    case 1:
      return concat(head, u32be(offset), u16be(size));
    case ExternalOp.INSERT_FILE:
      return opEnd ? head : concat(head, u32be(size), encPath(filePath || ''));
    case ExternalOp.DELETE_FILE:
      return !opEnd && path ? concat(head, path) : head;
    case ExternalOp.ERASE:
      return concat(head, u32be(offset), u16be(size));
    default:
      return head;
  }
}

/**
 * Decode accumulated file-browse entry bytes into entries.
 * Entry layout (per qix-ble / the app's file_browse):
 *   header(1) | cluster(4 BE) | fileNum(2 BE) | nameLen(1) | name(nameLen)
 *   header bit0 = is_file, bit1 = 0→UTF-16LE / 1→ASCII, bits2-6 = device index.
 */
export function parseFileEntries(data, queryType) {
  const entries = [];
  let offset = 0;
  const dec = new TextDecoder('utf-16le');
  while (offset + 8 <= data.length) {
    const header = data[offset];
    const isFile = (header & 0x01) !== 0;
    const isUnicode = (header & 0x02) === 0;
    const devIndex = (header >> 2) & 0x1f;
    const cluster =
      ((data[offset + 1] << 24) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 8) |
        data[offset + 4]) >>>
      0;
    const fileNum = (data[offset + 5] << 8) | data[offset + 6];
    const nameLen = data[offset + 7];
    offset += 8;
    if (offset + nameLen > data.length) break;
    const nameBytes = data.slice(offset, offset + nameLen);
    offset += nameLen;

    let name;
    if (isUnicode && nameLen >= 2 && nameLen % 2 === 0) {
      name = dec.decode(nameBytes).replace(/\u0000+$/, '');
    } else {
      name = Array.from(nameBytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      name = name.replace(/\.+$/, '');
    }
    entries.push({
      type: queryType,
      typeName: isFile ? 'file' : 'folder',
      isFile,
      id: fileNum,
      size: 0,
      cluster,
      devIndex,
      name,
    });
  }
  return entries;
}

/** Auth + framed RCSP session over AE01/AE02. */
export class RcspSession {
  /**
   * @param {BluetoothRemoteGATTCharacteristic} writeChar AE01
   * @param {BluetoothRemoteGATTCharacteristic} notifyChar AE02
   * @param {{onLog?: (msg:string, level?:string)=>void}} [opts]
   */
  constructor(writeChar, notifyChar, { onLog = () => {} } = {}) {
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.onLog = onLog;
    this.sn = 0;
    this.authDone = false;

    this._raw = []; // queued raw chunks (auth phase)
    this._rawWaiters = [];
    this._frameBuf = new Uint8Array(0);
    this._frameQueue = [];
    this._frameWaiters = [];

    this._onValue = (ev) => this._onNotify(new Uint8Array(ev.target.value.buffer));
  }

  async start() {
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onValue);
  }

  stop() {
    try {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this._onValue);
    } catch {
      /* ignore */
    }
    try {
      this.notifyChar.stopNotifications?.();
    } catch {
      /* ignore */
    }
  }

  // ── Notification handling ────────────────────────────────────────────────

  _onNotify(chunk) {
    if (!this.authDone) {
      // Deliver to the first matching raw waiter, else queue for later.
      for (let i = 0; i < this._rawWaiters.length; i++) {
        const w = this._rawWaiters[i];
        if (w.pred(chunk)) {
          this._rawWaiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(chunk);
          return;
        }
      }
      if (this._raw.length < 32) this._raw.push(chunk);
      return;
    }
    this._frameBuf = concat(this._frameBuf, chunk);
    this._pumpFrames();
  }

  _pumpFrames() {
    for (;;) {
      // resync on FE DC BA
      let i = -1;
      for (let k = 0; k + 2 < this._frameBuf.length; k++) {
        if (this._frameBuf[k] === 0xfe && this._frameBuf[k + 1] === 0xdc && this._frameBuf[k + 2] === 0xba) {
          i = k;
          break;
        }
      }
      if (i < 0) {
        if (this._frameBuf.length > 2) this._frameBuf = this._frameBuf.slice(-2);
        return;
      }
      if (i > 0) this._frameBuf = this._frameBuf.slice(i);
      if (this._frameBuf.length < 8) return;
      const paramLen = (this._frameBuf[5] << 8) | this._frameBuf[6];
      const total = paramLen + 8;
      if (this._frameBuf.length < total) return;
      const frame = this._frameBuf.slice(0, total);
      this._frameBuf = this._frameBuf.slice(total);
      let pkt;
      try {
        pkt = parseRcspFrame(frame);
      } catch (e) {
        this.onLog(`RCSP parse error: ${e.message}`, 'warn');
        continue;
      }
      this.onLog(
        `← RCSP ${pkt.type ? 'cmd' : 'resp'} cmd=0x${pkt.opcode.toString(16)} sn=${pkt.sn}` +
          `${pkt.type ? '' : ` status=0x${pkt.status.toString(16)}`}` +
          `${pkt.xmOpCode != null ? ` xm=0x${pkt.xmOpCode.toString(16)}` : ''} ${pkt.payload.length}B`,
        'info',
      );
      const w = this._frameWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(pkt);
      } else if (this._frameQueue.length < 64) {
        this._frameQueue.push(pkt);
      }
    }
  }

  _waitRaw(pred, timeoutMs) {
    const idx = this._raw.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this._raw.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = this._rawWaiters.indexOf(w);
        if (i >= 0) this._rawWaiters.splice(i, 1);
        reject(new Error('RCSP auth: timeout waiting for device data'));
      }, timeoutMs);
      this._rawWaiters.push(w);
    });
  }

  _waitFrame(timeoutMs) {
    if (this._frameQueue.length) return Promise.resolve(this._frameQueue.shift());
    return new Promise((resolve, reject) => {
      const w = { resolve };
      w.timer = setTimeout(() => {
        const i = this._frameWaiters.indexOf(w);
        if (i >= 0) this._frameWaiters.splice(i, 1);
        reject(new Error('RCSP: timeout waiting for frame'));
      }, timeoutMs);
      this._frameWaiters.push(w);
    });
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async _writeRaw(bytes) {
    const props = this.writeChar.properties || {};
    const maxChunk = 200;
    for (let o = 0; o < bytes.length; o += maxChunk) {
      const chunk = bytes.subarray(o, Math.min(o + maxChunk, bytes.length));
      if (props.write && !props.writeWithoutResponse) {
        await this.writeChar.writeValueWithResponse(chunk);
      } else {
        await this.writeChar.writeValueWithoutResponse(chunk);
      }
      if (o + maxChunk < bytes.length) await new Promise((r) => setTimeout(r, 10));
    }
  }

  async _sendFrame(cmd, paramData, { type = 1, hasResponse = 1, status = 0, sn = null, xmOpCode = null } = {}) {
    const useSn = sn == null ? this.sn : sn;
    if (sn == null) this.sn = (this.sn + 1) & 0xff;
    const frame = buildRcspFrame(cmd, paramData || new Uint8Array(0), useSn, {
      type,
      hasResponse,
      status,
      xmOpCode,
    });
    this.onLog(`→ RCSP ${type ? 'cmd' : 'resp'} cmd=0x${cmd.toString(16)} ${toHex(frame)}`, 'info');
    await this._writeRaw(frame);
    return frame;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Run the 6-step JieLi RCSP auth handshake. Must succeed before any command.
   * @param {{timeoutMs?:number, resetAuthFlag?:boolean}} [opts]
   */
  async auth({ timeoutMs = 6000, resetAuthFlag = true } = {}) {
    if (this.authDone) return;
    this.onLog('RCSP auth: starting 6-step handshake…', 'info');

    if (resetAuthFlag) {
      // The SuperBand app's RcspAuth sends this first (cmd 6, param 1) and then
      // waits 500 ms; the qix-ble capture omits it. Our step-2 wait ignores
      // non-matching chunks, so sending it is safe either way.
      await this._sendFrame(0x06, u8(0x01), { type: 1, hasResponse: 1, sn: 0 });
      await new Promise((r) => setTimeout(r, 500));
    }

    const random = randomAuthData();
    await this._writeRaw(concat(u8(AUTH_STEP.CHALLENGE), random));

    const resp2 = await this._waitRaw((c) => c.length === 17 && c[0] === AUTH_STEP.ENCRYPTED, timeoutMs);
    const expected = jliEncrypt(random);
    if (!bytesEqual(resp2.slice(1), expected)) {
      throw new Error(
        `RCSP auth step 2 mismatch (got ${toHex(resp2.slice(1))}, expected ${toHex(expected)}) — wrong key/firmware?`,
      );
    }
    this.onLog('RCSP auth: step 2 verified (device encrypted our challenge)', 'ok');

    await this._writeRaw(AUTH_STEP.PASS);

    const resp4 = await this._waitRaw((c) => c.length === 17 && c[0] === AUTH_STEP.CHALLENGE, timeoutMs);
    const answer = jliEncrypt(resp4.slice(1));
    await this._writeRaw(concat(u8(AUTH_STEP.ENCRYPTED), answer));

    await this._waitRaw((c) => c.length === 5 && bytesEqual(c, AUTH_STEP.PASS), timeoutMs);

    this.authDone = true;
    this._frameBuf = new Uint8Array(0);
    this._raw = [];
    this.onLog('RCSP auth: COMPLETE', 'ok');
  }

  // ── Framed commands ──────────────────────────────────────────────────────

  /** Send a command and return the first matching response frame. */
  async request(cmd, paramData = new Uint8Array(0), { timeoutMs = 8000 } = {}) {
    if (!this.authDone) throw new Error('RCSP: not authenticated');
    await this._sendFrame(cmd, paramData, { type: 1, hasResponse: 1 });
    for (;;) {
      const pkt = await this._waitFrame(timeoutMs);
      if (pkt.type === 0 && pkt.opcode === cmd) return pkt;
      // ignore device pushes / unrelated frames
    }
  }

  getTargetInfo(opts) {
    return this.request(RcspCmd.GET_TARGET_INFO, u8(0xff, 0xff, 0xff, 0xff, 0x00), opts);
  }

  externalFlash(param, opts) {
    return this.request(RCSP_EXTERNAL_FLASH_CMD, param, opts);
  }

  // ── File browse ──────────────────────────────────────────────────────────

  /**
   * List files/folders on one storage device.
   *
   * Param mirrors the SDK's `PathData.toData()` (all fields big-endian):
   *   type(1) readNum(1) startIndex(2 BE) devHandler(4 BE) pathLen(2 BE) path(4 BE each)
   * The SDK's default path is `[0]`.
   *
   * @param {{devHandler?:number, type?:number, readNum?:number, startIndex?:number, path?:number[], pathLenLittle?:boolean, timeoutMs?:number}} [opts]
   */
  async browse({ devHandler = DeviceHandler.FLASH, type = 0, readNum = 255, startIndex = 0, path = [0], pathLenLittle = false, timeoutMs = 8000 } = {}) {
    if (!this.authDone) throw new Error('RCSP: not authenticated');
    const pathBytes = concat(...path.map((c) => u32be(c)));
    const param = concat(
      u8(type, readNum),
      u16be(startIndex),
      u32be(devHandler),
      pathLenLittle ? u16le(pathBytes.length) : u16be(pathBytes.length),
      pathBytes,
    );

    await this._sendFrame(RcspFsCmd.START_FILE_BROWSE, param, { type: 1, hasResponse: 1 });

    let entryBuf = new Uint8Array(0);
    for (;;) {
      const pkt = await this._waitFrame(timeoutMs);
      if (pkt.type === 0 && pkt.opcode === RcspFsCmd.START_FILE_BROWSE) {
        if (pkt.status !== 0) throw new Error(`browse rejected (status 0x${pkt.status.toString(16)})`);
        continue;
      }
      if (pkt.type === 1 && pkt.opcode === RcspFsCmd.DATA_PUSH && pkt.xmOpCode === RcspFsCmd.START_FILE_BROWSE) {
        entryBuf = concat(entryBuf, pkt.payload);
        await this._sendFrame(RcspFsCmd.DATA_PUSH, new Uint8Array(0), {
          type: 0,
          status: 0,
          sn: pkt.sn,
          xmOpCode: RcspFsCmd.START_FILE_BROWSE,
        });
        continue;
      }
      if (pkt.type === 1 && pkt.opcode === RcspFsCmd.STOP_FILE_BROWSE) {
        await this._sendFrame(RcspFsCmd.STOP_FILE_BROWSE, new Uint8Array(0), { type: 0, status: 0, sn: pkt.sn });
        break;
      }
      // ignore anything else
    }
    return parseFileEntries(entryBuf, type);
  }

  /** Browse every storage handler, skipping ones that reject (e.g. absent). */
  async browseAll({ type = 0, readNum = 255, path = [0], pathLenLittle = false } = {}) {
    const all = [];
    for (const handler of [DeviceHandler.USB, DeviceHandler.SD0, DeviceHandler.SD1, DeviceHandler.FLASH]) {
      try {
        const entries = await this.browse({ devHandler: handler, type, readNum, path, pathLenLittle });
        if (entries.length) this.onLog(`RCSP ${DEVICE_NAMES[handler]}: ${entries.length} entries`, 'info');
        all.push(...entries);
      } catch (e) {
        this.onLog(`RCSP ${DEVICE_NAMES[handler]}: skipped (${e.message})`, 'warn');
      }
    }
    return all;
  }

  // ── File read (small-file op) ────────────────────────────────────────────

  /**
   * Read bytes from a file by id via cmd 0x28 op=1.
   * @param {{id:number, type?:number}} entry
   * @param {{offset?:number, length?:number, timeoutMs?:number}} [opts]
   * @returns {Promise<{data:Uint8Array, crc16:number}>}
   */
  async readFileAt(entry, { offset = 0, length = 0xffff, timeoutMs = 9000 } = {}) {
    if (!this.authDone) throw new Error('RCSP: not authenticated');
    const body = concat(
      u8(0x01, entry.type & 0xff),
      u16be(entry.id),
      u16be(offset),
      u16be(length),
      u8(0x01),
    );
    const pkt = await this.request(RcspFsCmd.SMALL_FILE_OP, body, { timeoutMs });
    const p = pkt.payload;
    if (p.length < 3) throw new Error(`read: response too short (${p.length}B)`);
    let ret;
    let crcHi;
    let crcLo;
    let start;
    if (p[0] === 0x00) {
      [ret, crcHi, crcLo] = [p[0], p[1], p[2]];
      start = 3;
    } else if (p.length >= 4 && p[1] === 0x00) {
      [ret, crcHi, crcLo] = [p[1], p[2], p[3]];
      start = 4;
    } else {
      ret = p[0];
      crcHi = crcLo = 0;
      start = 3;
    }
    if (ret !== 0x00) throw new Error(`read: badge status 0x${ret.toString(16)}`);
    const data = p.slice(start);
    this.onLog(`RCSP read id=0x${entry.id.toString(16)} off=${offset} → ${data.length}B crc=0x${((crcHi << 8) | crcLo).toString(16)}`, 'info');
    return { data, crc16: (crcHi << 8) | crcLo };
  }

  /** Read a whole file: chunk cmd 0x28 reads until a short chunk / cap. */
  async readFile(entry, { chunkSize = 0x8000, maxBytes = 4 * 1024 * 1024, onProgress = null } = {}) {
    const parts = [];
    let offset = 0;
    for (;;) {
      const { data } = await this.readFileAt(entry, { offset, length: Math.min(0xffff, chunkSize) });
      if (!data.length) break;
      parts.push(data);
      offset += data.length;
      if (onProgress) onProgress(offset);
      if (data.length < Math.min(0xffff, chunkSize)) break;
      if (offset >= maxBytes) break;
    }
    return concat(...parts);
  }
}
