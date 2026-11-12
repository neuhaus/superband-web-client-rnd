/**
 * JieLi RCSP — external-flash / watch-resource commands.
 *
 * The SuperBand app manages the badge's stored faces through JieLi's RCSP
 * "external flash" file API (`com.jieli.jl_rcsp` / `jl_fatfs`), NOT the 0xCD
 * dial protocol. The badge exposes RCSP on AE00/AE01/AE02 (same service the OTA
 * path uses), so we reuse the RCSP framing from ./jieli-ota.js and add the
 * external-flash command (command id 26).
 *
 * Param layout (ExternalFlashIOCtrlParam): op(1) | flag(1) | …
 *   op 5  delete file : flag 1 + path (start), then flag 0 (end)
 *   op 12 get left space
 *   op 11 get file msg : path
 *   op 3  watch op : flag is the sub-op (0 = current watch, 4 = enable custom bg)
 */

import { buildRcspFrame, parseRcspFrame, RcspCmd } from './jieli-ota.js';
import { toHex } from './protocol.js';

/** RCSP command id for ExternalFlashIOCtrlCmd (com.jieli.jl_rcsp). */
export const RCSP_EXTERNAL_FLASH_CMD = 26;

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

function u16be(v) {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
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

function encPath(path) {
  return new TextEncoder().encode(path || '');
}

/**
 * Build an ExternalFlashIOCtrl param.
 * @param {{op:number, flag?:number, filePath?:string, offset?:number, size?:number}} o
 */
export function buildExternalFlashParam({ op, flag = 0, filePath = null, offset = 0, size = 0 } = {}) {
  const opEnd = (flag & 1) === 0; // setFlag(): even flag → op end
  const head = new Uint8Array([op & 0xff, flag & 0xff]);
  const path = filePath != null ? encPath(filePath) : null;

  switch (op) {
    case ExternalOp.WATCH_OP:
      // flag IS the watch sub-op here; path only for sub-ops 1..5.
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

/** Minimal RCSP request/response session over AE01/AE02. */
export class RcspSession {
  constructor(writeChar, notifyChar, { onLog = () => {} } = {}) {
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.onLog = onLog;
    this.sn = 0;
    this.buf = new Uint8Array(0);
    this.pending = [];
    this._onValue = (ev) => this._handle(new Uint8Array(ev.target.value.buffer));
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

  _handle(chunk) {
    this.buf = concat(this.buf, chunk);
    while (this.buf.length >= 8) {
      // resync on the FE DC BA prefix
      if (this.buf[0] !== 0xfe || this.buf[1] !== 0xdc || this.buf[2] !== 0xba) {
        let i = -1;
        for (let k = 1; k + 1 < this.buf.length; k++) {
          if (this.buf[k] === 0xfe && this.buf[k + 1] === 0xdc) {
            i = k;
            break;
          }
        }
        if (i < 0) {
          this.buf = new Uint8Array(0);
          return;
        }
        this.buf = this.buf.slice(i);
        if (this.buf.length < 8) return;
      }
      // paramLen is u16 big-endian at offset 5; total = 3 prefix + 4 header + paramLen + 1 end
      const paramLen = (this.buf[5] << 8) | this.buf[6];
      const total = paramLen + 8;
      if (this.buf.length < total) return;
      const frame = this.buf.slice(0, total);
      this.buf = this.buf.slice(total);
      try {
        const pkt = parseRcspFrame(frame);
        this.onLog(
          `← RCSP type=${pkt.type} sn=${pkt.sn} op=0x${pkt.opcode.toString(16)} ` +
            `status=0x${(pkt.status ?? 0).toString(16)} payload=${toHex(pkt.payload)}`,
          'info',
        );
        const r = this.pending.shift();
        if (r) r(pkt);
      } catch (e) {
        this.onLog(`RCSP parse error: ${e.message}`, 'warn');
      }
    }
  }

  send(opcode, payload = new Uint8Array(0), { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (pkt) => {
        clearTimeout(timer);
        resolve(pkt);
      };
      timer = setTimeout(() => {
        const i = this.pending.indexOf(done);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`RCSP timeout (op 0x${opcode.toString(16)})`));
      }, timeoutMs);
      this.pending.push(done);

      const frame = buildRcspFrame(opcode, payload, this.sn);
      this.sn = (this.sn + 1) & 0xff;
      this.onLog(`→ RCSP op=0x${opcode.toString(16)} ${toHex(frame)}`, 'info');

      const props = this.writeChar.properties || {};
      const write = props.write
        ? this.writeChar.writeValueWithResponse(frame)
        : this.writeChar.writeValueWithoutResponse(frame);
      Promise.resolve(write).catch((e) => {
        clearTimeout(timer);
        const i = this.pending.indexOf(done);
        if (i >= 0) this.pending.splice(i, 1);
        reject(e);
      });
    });
  }

  getTargetInfo(opts) {
    // SDK sends GetTargetInfoParam(-1) → mask FFFFFFFF, platform 0.
    return this.send(RcspCmd.GET_TARGET_INFO, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00]), opts);
  }

  externalFlash(param, opts) {
    return this.send(RCSP_EXTERNAL_FLASH_CMD, param, opts);
  }
}
