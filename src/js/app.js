import { SuperBandClient, FileType, FunctionType } from './client.js';
import { prepareFileForBadge, formatBytes, DEFAULT_DIAL } from './image.js';
import {
  extractFramesForBadge,
  fitAvi,
  isSupportedVideoFile,
  WATCH_VIDEO,
} from './video.js';
import { REPO_URL } from './protocol.js';
import { bindAdvanced } from './advanced.js';
import { bindExtras } from './extras.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const client = new SuperBandClient();
let prepared = null;
let transferring = false;
let videoPrepared = null;

function setPill(el, text, state = '') {
  el.textContent = text;
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

function syncProtocolUi() {
  // Baji-only controls are dead weight (and confusing) on a FitPro dial badge,
  // and device controls stay hidden until a badge is connected.
  const on = client.sessionCount > 0 && client.connected;
  const isFitPro = client.getSnapshot?.().protocolMode === 'fitpro';
  const mediaSection = $('#mediaLibrarySection');
  if (mediaSection) mediaSection.hidden = !on || isFitPro;
  for (const sel of ['#functionType', '#allocMedia']) {
    const field = $(sel)?.closest('label');
    if (field) field.hidden = isFitPro;
  }
}

function syncConnectionChrome() {
  const n = client.sessionCount;
  const on = n > 0 && client.connected;
  $$('[data-need-conn]').forEach((b) => {
    b.disabled = !on;
  });

  // Show device controls only while a badge is connected; otherwise show a
  // short prompt instead of a wall of disabled buttons.
  $$('[data-conn-only]').forEach((el) => {
    el.hidden = !on;
  });
  $$('[data-no-conn]').forEach((el) => {
    el.hidden = on;
  });

  // Always allow adding another device while Web Bluetooth works
  $('#btnConnect').hidden = false;
  $('#btnConnectAny').hidden = false;
  $('#btnConnect').textContent = n ? 'Add badge' : 'Connect badge';
  $('#btnConnectAny').textContent = n ? 'Add other' : 'Other device';
  $('#btnAddBadge').hidden = n === 0;
  $('#btnDisconnect').hidden = n === 0;
  $('#btnDisconnectAll').hidden = n < 2;
  $('#btnPushAll').hidden = n < 2;

  const label =
    n === 0
      ? 'Disconnected'
      : n === 1
        ? `Connected · ${client.name || 'badge'}`
        : `${n} badges · active ${client.name || '—'}`;
  setPill($('#connPill'), label, n ? 'ok' : '');
  $('#deviceGlance').hidden = !on;
  $('#deviceRail').hidden = n === 0;
  $('#deviceCount').textContent = String(n);
  updatePushChecklist();
  syncProtocolUi();
}

function renderDeviceChips() {
  const box = $('#deviceChips');
  box.innerHTML = '';
  for (const s of client.sessions) {
    const chip = document.createElement('div');
    chip.className = 'device-chip' + (s.active ? ' active' : '');
    chip.dataset.id = s.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'device-chip-main';
    main.title = 'Make active';
    const title = s.name || 'Badge';
    const sub = [s.firmware, s.battery != null ? `${s.battery}%` : null].filter(Boolean).join(' · ');
    main.innerHTML = `<span class="chip-name"></span><span class="chip-sub"></span>`;
    main.querySelector('.chip-name').textContent = title + (s.active ? ' · active' : '');
    main.querySelector('.chip-sub').textContent = sub || s.id.slice(0, 8);
    main.addEventListener('click', () => {
      try {
        client.setActive(s.id);
        toast(`Active: ${client.name || s.id}`, 'ok');
        if (client.getSnapshot().protocolMode === 'baji') {
          client.requestMediaList().catch((e) => {
            log({ msg: `Media list: ${e.message}`, level: 'warn' });
          });
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'device-chip-x';
    x.title = 'Disconnect this badge';
    x.textContent = '×';
    x.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await client.disconnect(s.id);
        toast('Badge disconnected', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    chip.appendChild(main);
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function log({ msg, level = 'info' }) {
  const box = $('#activityLog');
  const row = document.createElement('div');
  row.className = `log-line ${level}`;
  row.innerHTML = `<span class="t"></span><span class="m"></span>`;
  row.querySelector('.t').textContent = new Date().toLocaleTimeString();
  row.querySelector('.m').textContent = msg;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.hidden = false;
  el.dataset.kind = kind;
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
    }, 280);
  }, 2800);
}

function fmtBig(n) {
  if (n == null) return '—';
  const v = typeof n === 'bigint' ? Number(n) : Number(n);
  if (!Number.isFinite(v)) return String(n);
  return formatBytes(v);
}

function dash(v) {
  return v == null || v === '' ? '—' : String(v);
}

function renderSnapshot(snap) {
  const s = snap || client.getSnapshot();
  const battery = s.battery == null ? '—' : `${s.battery}%`;

  const fields = {
    name: dash(s.name),
    model: dash(s.model),
    firmware: dash(s.firmware),
    hardware: dash(s.hardware),
    software: dash(s.software),
    manufacturer: dash(s.manufacturer),
    mac: dash(s.mac),
    battery,
    protocol: dash(s.protocol),
    free: fmtBig(s.freeStorage),
    cap: fmtBig(s.storageCapacity),
  };

  for (const [key, val] of Object.entries(fields)) {
    $$('[data-field="' + key + '"]').forEach((el) => {
      el.textContent = val;
    });
  }

  const glance = {
    name: fields.name,
    model: fields.model,
    firmware: fields.firmware,
    battery: fields.battery,
    hardware: fields.hardware,
    free: fields.free,
  };
  for (const [key, val] of Object.entries(glance)) {
    const el = document.querySelector(`[data-glance="${key}"]`);
    if (el) el.textContent = val;
  }

  if (s.protocolMode === 'fitpro') {
    $('#mediaIdPill').textContent = 'FitPro dial31';
    if (s.dialWidth && s.dialHeight) {
      const w = $('#dialW');
      const h = $('#dialH');
      if (w && Number(w.value) !== s.dialWidth) w.value = String(s.dialWidth);
      if (h && Number(h.value) !== s.dialHeight) h.value = String(s.dialHeight);
    }
  } else if (s.mediaId != null) {
    $('#mediaIdPill').textContent = `Media ID ${s.mediaId}`;
  } else if (!s.connected) {
    $('#mediaIdPill').textContent = 'Media ID —';
  }

  syncProtocolUi();
}

function updatePushChecklist() {
  const connected = client.connected;
  const imageReady = !!prepared;
  const idle = !transferring && !client.anyTransferring && !client.anyPreviewing;
  const map = { conn: connected, image: imageReady, idle };
  for (const [key, ok] of Object.entries(map)) {
    const li = document.querySelector(`[data-check="${key}"]`);
    if (!li) continue;
    li.dataset.ok = ok ? '1' : '0';
  }
  const canPush = connected && imageReady && idle;
  $('#btnPush').disabled = !canPush;
  $('#btnPushAll').disabled = !(client.sessionCount >= 2 && imageReady && idle);
  const isFitPro = client.getSnapshot?.().protocolMode === 'fitpro';
  $('#btnPushVideo').disabled = !(connected && !!videoPrepared && idle && isFitPro);
}

function renderMediaList(items) {
  const box = $('#mediaList');
  if (!items?.length) {
    box.innerHTML =
      '<div class="empty">No media entries parsed (device may use a different list layout). Push still works.</div>';
    return;
  }
  box.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'media-item';
    row.innerHTML = `
      <div class="meta">
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <button class="danger" type="button">Delete</button>`;
    row.querySelector('.title').textContent = item.name || `Media ${item.mediaId}`;
    row.querySelector('.sub').textContent =
      `id=${item.mediaId} · ${formatBytes(item.fileSize)} · type=${item.fileType}`;
    row.querySelector('button').addEventListener('click', async () => {
      try {
        await client.deleteMedia(item.mediaId);
        toast(`Delete sent for ${item.mediaId}`, 'ok');
        await client.requestMediaList().catch(() => {});
      } catch (e) {
        toast(e.message, 'err');
        log({ msg: e.message, level: 'err' });
      }
    });
    box.appendChild(row);
  }
}

async function connect(acceptAll) {
  try {
    setPill($('#connPill'), 'Connecting…', 'busy');
    await client.connect({ acceptAll });
    syncConnectionChrome();
    renderDeviceChips();
    renderSnapshot();
    toast(
      client.sessionCount > 1
        ? `Added · ${client.sessionCount} badges connected`
        : 'Badge connected',
      'ok',
    );
    const snap = client.getSnapshot();
    if (snap.protocolMode === 'baji') {
      client.requestMediaList().catch((e) => {
        log({ msg: `Media list: ${e.message}`, level: 'warn' });
      });
    } else if (snap.protocolMode === 'fitpro') {
      log({ msg: 'FitPro badge — media library skipped (use Push for dial31 upload)', level: 'info' });
    }
    // Re-encode for protocol (FitPro RGB565 vs Baji/alg4 JPEG).
    if ($('#imageInput').files?.length) await rebuildPreview();
  } catch (e) {
    syncConnectionChrome();
    renderDeviceChips();
    if (!client.sessionCount) {
      setPill($('#connPill'), 'Connect failed', 'err');
    }
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  }
}

async function rebuildPreview() {
  const file = $('#imageInput').files?.[0];
  if (!file) {
    prepared = null;
    updatePushChecklist();
    return;
  }
  try {
    // BJ/DG FitPro: RGB565 dial type 0. Baji / algorithm-4 JPEG only when needed.
    const snap = client.getSnapshot();
    const useJpeg = snap.protocolMode === 'baji' || snap.dialAlgorithm === 4;
    prepared = await prepareFileForBadge(file, {
      width: Number($('#dialW').value) || DEFAULT_DIAL.width,
      height: Number($('#dialH').value) || DEFAULT_DIAL.height,
      quality: 0.5,
      round: $('#roundMask').checked,
      format: useJpeg ? 'jpeg444' : 'rgb565',
    });
    const img = $('#dialPreview');
    img.src = prepared.previewUrl;
    img.hidden = false;
    $('#dialPlaceholder').hidden = true;
    $('#dial').classList.toggle('round', $('#roundMask').checked);
    const fmtLabel = prepared.format === 'jpeg444' ? 'JPEG 4:4:4' : 'RGB565';
    $('#imageMeta').textContent =
      `${file.name} → ${prepared.width}×${prepared.height} ${fmtLabel} · ${formatBytes(prepared.bytes.length)}`;
    updatePushChecklist();
  } catch (e) {
    prepared = null;
    updatePushChecklist();
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  }
}

async function pushImage() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  if (!prepared) {
    toast('Choose an image first', 'err');
    return;
  }
  const bar = $('#pushBar');
  const wrap = $('#pushProgress');
  wrap.hidden = false;
  bar.style.width = '0%';
  transferring = true;
  updatePushChecklist();
  try {
    const functionType = Number($('#functionType').value) || FunctionType.BACKGROUND;
    const result = await client.transferFile(prepared.bytes, {
      fileType: FileType.IMAGE,
      functionType,
      allocateId: $('#allocMedia').checked,
      onProgress: (pct) => {
        bar.style.width = `${pct}%`;
      },
    });
    const via = result.path === 'fitpro-dial31' ? 'dial31' : 'baji';
    toast(
      result.verified === false
        ? 'Uploaded (verify unclear)'
        : `Pushed to ${client.name || 'badge'} (${via})`,
      'ok',
    );
    log({
      msg: `Push complete → ${client.name || result.sessionId} via=${via} id=${result.mediaId} sum=0x${Number(result.checksum).toString(16)}`,
      level: 'ok',
    });
    if (via === 'baji') {
      $('#mediaIdPill').textContent = `Media ID ${result.mediaId}`;
      client.requestMediaList().catch(() => {});
    } else {
      $('#mediaIdPill').textContent = 'FitPro dial31';
    }
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  } finally {
    transferring = false;
    updatePushChecklist();
    setTimeout(() => {
      wrap.hidden = true;
    }, 900);
  }
}

async function pushAll() {
  if (client.sessionCount < 2) {
    toast('Connect at least two badges', 'err');
    return;
  }
  if (!prepared) {
    toast('Choose an image first', 'err');
    return;
  }
  const bar = $('#pushBar');
  const wrap = $('#pushProgress');
  wrap.hidden = false;
  bar.style.width = '0%';
  transferring = true;
  updatePushChecklist();
  log({
    msg: `Simultaneous push to ${client.sessionCount} badges…`,
    level: 'info',
  });
  try {
    const functionType = Number($('#functionType').value) || FunctionType.BACKGROUND;
    const results = await client.transferFileToAll(prepared.bytes, {
      fileType: FileType.IMAGE,
      functionType,
      allocateId: $('#allocMedia').checked,
      onProgress: (pct, detail) => {
        bar.style.width = `${pct}%`;
        if (detail?.perBadge?.length) {
          const bits = detail.perBadge
            .map((b) => `${b.name || b.sessionId} ${b.percent}%`)
            .join(' · ');
          bar.title = bits;
        }
      },
    });
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    toast(
      fail
        ? `Simultaneous push: ${ok}/${results.length} ok`
        : `Pushed to all ${ok} badges (simultaneous)`,
      fail ? 'err' : 'ok',
    );
    for (const r of results) {
      log({
        msg: r.ok
          ? `Push OK → ${r.name || r.sessionId} mediaId=${r.mediaId}`
          : `Push fail → ${r.name || r.sessionId}: ${r.error}`,
        level: r.ok ? 'ok' : 'err',
      });
    }
    renderSnapshot();
    client.requestMediaList().catch(() => {});
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  } finally {
    transferring = false;
    updatePushChecklist();
    setTimeout(() => {
      wrap.hidden = true;
    }, 900);
  }
}

async function rebuildVideoPreview() {
  const file = $('#videoInput').files?.[0];
  if (!file) {
    videoPrepared = null;
    $('#aviPreview').hidden = true;
    $('#aviPlaceholder').hidden = false;
    $('#videoMeta').textContent = 'No video selected.';
    updatePushChecklist();
    return;
  }
  if (!isSupportedVideoFile(file)) {
    videoPrepared = null;
    updatePushChecklist();
    toast('Unsupported file — use GIF/WebP/APNG or an MP4/MOV/WebM video', 'err');
    return;
  }
  try {
    const width = Number($('#videoW').value) || 240;
    const height = Number($('#videoH').value) || 240;
    const fps = Number($('#videoFps').value) || WATCH_VIDEO.fps;
    const result = await extractFramesForBadge(file, {
      width,
      height,
      fps,
      maxSeconds: Number($('#videoSeconds').value) || WATCH_VIDEO.maxSeconds,
      round: $('#videoRound').checked,
    });
    videoPrepared = {
      sources: result.sources,
      width,
      height,
      fps,
      source: result.source,
      sourceFrames: result.sourceFrames,
    };
    const img = $('#aviPreview');
    img.src = result.previewUrl;
    img.hidden = false;
    $('#aviPlaceholder').hidden = true;
    $('#aviDial').classList.toggle('round', $('#videoRound').checked);
    const src =
      result.source === 'animated-image'
        ? `${result.sourceFrames ?? result.sources.length}-frame image`
        : `${result.duration ? `${result.duration.toFixed(1)}s` : 'video'}`;
    $('#videoMeta').textContent =
      `${file.name} (${src}) → ${result.sources.length} frames @ ${fps} fps · ${width}×${height}`;
    updatePushChecklist();
  } catch (e) {
    videoPrepared = null;
    updatePushChecklist();
    toast(e.message, 'err');
    log({ msg: `Video prepare: ${e.message}`, level: 'err' });
  }
}

async function listDials() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  const out = $('#dialListOut');
  try {
    const { raw, payload, summary } = await client.dialList();
    out.hidden = false;
    out.textContent = `dial list (0x20/3) — ${payload.length} B\n${summary}`;
    log({ msg: `Dial list ← ${raw}`, level: 'info' });
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: `Dial list: ${e.message}`, level: 'err' });
  }
}

async function listPresetDials() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  const out = $('#dialListOut');
  try {
    const { raw, payload, summary } = await client.dialPresetList();
    out.hidden = false;
    out.textContent = `dial preset list (0x20/5) — ${payload.length} B\n${summary}`;
    log({ msg: `Dial preset list ← ${raw}`, level: 'info' });
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: `Dial preset list: ${e.message}`, level: 'err' });
  }
}

async function rcspProbe() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  const out = $('#dialListOut');
  out.hidden = false;
  out.textContent = 'RCSP probe running — see the activity log…';
  try {
    const r = await client.rcspProbe();
    const line = (name, v) =>
      `${name}: ${v?.error ? `error: ${v.error}` : `op=0x${v.opcode.toString(16)} status=0x${(v.status ?? 0).toString(16)} payload=${[...(v.payload || [])].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`}`;
    const free = (() => {
      const p = r.free?.payload;
      if (!p || p.length < 5) return '';
      const k = ((p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4]) >>> 0;
      return `   = ${k} KiB (${k * 1024} B free)`;
    })();
    const watch = (() => {
      const p = r.current?.payload;
      if (!p || p.length < 2) return '';
      return `   = ${JSON.stringify(new TextDecoder().decode(p.slice(1)).replace(/\u0000+$/, ''))}`;
    })();
    const storage = (r.storages || [])
      .map((s) => `  ${s.name} index=${s.index} handle=${s.handle ?? '-'} ${s.online ? 'online' : 'offline'}`)
      .join('\n');
    out.textContent = [
      'RCSP auth + info (post-auth)',
      line('GET_TARGET_INFO', r.target),
      line('external-flash op 12 (free space)', r.free) + free,
      line('external-flash op 3/0 (current watch)', r.current) + watch,
      storage ? `storages:\n${storage}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    toast('RCSP probe done — see log', 'ok');
  } catch (e) {
    out.textContent = `RCSP probe failed: ${e.message}`;
    toast(e.message, 'err');
    log({ msg: `RCSP probe: ${e.message}`, level: 'err' });
  }
}

/** List stored files over RCSP (authenticated) and render with Download buttons. */
async function listFacesRcsp() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  const box = $('#rcspFaceList');
  box.hidden = false;
  box.textContent = 'RCSP: authenticating + browsing… (see log)';
  try {
    const entries = await client.rcspList();
    const state = { entries };
    renderFaceList(state);
    toast(entries.length ? `${entries.length} file(s)` : 'No files listed', entries.length ? 'ok' : 'warn');
  } catch (e) {
    box.textContent = `RCSP list failed: ${e.message}`;
    toast(e.message, 'err');
    log({ msg: `RCSP list: ${e.message}`, level: 'err' });
  }
}

function renderFaceList(state) {
  const box = $('#rcspFaceList');
  box.hidden = false;
  box.innerHTML = '';
  if (!state.entries.length) {
    box.textContent = 'No files listed (browse returned nothing — see the log).';
    return;
  }
  const table = document.createElement('table');
  table.className = 'faceTable';
  for (const entry of state.entries) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'mono';
    tdName.textContent = entry.name || '(unnamed)';
    const tdMeta = document.createElement('td');
    tdMeta.className = 'meta mono';
    tdMeta.textContent = `${entry.typeName} · id=0x${entry.id.toString(16)} · cluster=0x${(entry.cluster >>> 0).toString(16)}`;
    const tdAct = document.createElement('td');
    tdAct.className = 'act';
    const btn = document.createElement('button');
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadFace(entry, btn));
    tdAct.appendChild(btn);
    tr.append(tdName, tdMeta, tdAct);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

async function downloadFace(entry, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const { data } = await client.rcspDownload(entry);
    const name = (entry.name || `face_${entry.id.toString(16)}`).replace(/[^\w.-]+/g, '_');
    saveBlob(data, name);
    btn.textContent = `Saved ${data.length} B`;
    toast(`Downloaded ${name} (${data.length} B)`, 'ok');
    log({ msg: `RCSP download ${name} → ${data.length} B`, level: 'ok' });
  } catch (e) {
    btn.textContent = label;
    btn.disabled = false;
    toast(e.message, 'err');
    log({ msg: `RCSP download: ${e.message}`, level: 'err' });
  }
}

function saveBlob(data, name) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Download a stored file by FAT path (cmd 0x24 op=2) — e.g. "/WATCH". */
async function downloadPath() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  const path = ($('#rcspPath').value || '').trim() || '/WATCH';
  const btn = $('#btnRcspReadPath');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const { data } = await client.rcspDownloadPath(path);
    const name = path.replace(/^\/+/, '').replace(/[^\w.-]+/g, '_') || 'file.bin';
    saveBlob(data, name);
    toast(`Downloaded ${path} (${data.length} B)`, 'ok');
    log({ msg: `RCSP read ${path} → ${data.length} B`, level: 'ok' });
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: `RCSP read ${path}: ${e.message}`, level: 'err' });
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

async function deleteDial() {
  const id = Number($('#dialDeleteId').value);
  if (!Number.isFinite(id) || id < 0) {
    toast('Enter a dial id (use List first)', 'err');
    return;
  }
  if (!window.confirm(`Delete dial id ${id} from the badge? This cannot be undone.`)) return;
  try {
    await client.dialDelete(id);
    toast(`Delete sent for dial ${id}`, 'ok');
    log({ msg: `Dial delete sent → id ${id}`, level: 'ok' });
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  }
}

async function switchDial() {
  const id = Number($('#dialDeleteId').value);
  if (!Number.isFinite(id) || id < 0) {
    toast('Enter a dial id (use List first)', 'err');
    return;
  }
  try {
    await client.dialSwitch(id);
    toast(`Switch sent for dial ${id}`, 'ok');
    log({ msg: `Dial switch sent → id ${id}`, level: 'ok' });
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  }
}

async function queryVideoFreeSpace() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return null;
  }
  try {
    const { bytes, raw } = await client.dialRemainSpace();
    const txt = bytes == null ? `raw ${raw}` : formatBytes(bytes);
    $('#videoMeta').textContent = `Badge free dial space: ${txt}`;
    return bytes;
  } catch (e) {
    log({ msg: `Free-space query: ${e.message}`, level: 'warn' });
    return null;
  }
}

async function pushVideo() {
  if (!client.connected) {
    toast('Connect a badge first', 'err');
    return;
  }
  if (!videoPrepared) {
    toast('Choose a video or GIF first', 'err');
    return;
  }
  if (client.getSnapshot?.().protocolMode !== 'fitpro') {
    toast('Video push is FitPro-dial only for now', 'err');
    return;
  }
  const bar = $('#aviBar');
  const wrap = $('#aviProgress');
  wrap.hidden = false;
  bar.style.width = '0%';
  transferring = true;
  updatePushChecklist();
  try {
    const userMaxKb = Number($('#videoMaxKb').value) || Math.round(WATCH_VIDEO.maxBytes / 1024);
    let maxBytes = userMaxKb * 1024;
    // If the badge tells us its free dial space, never exceed it (keep a margin).
    const free = await queryVideoFreeSpace();
    if (free != null && free > 0) {
      const usable = free - 16 * 1024;
      if (usable > 0 && usable < maxBytes) {
        maxBytes = usable;
        log({
          msg: `Budget lowered to badge free space — ${formatBytes(maxBytes)}`,
          level: 'info',
        });
      }
    }
    const fit = await fitAvi(videoPrepared.sources, {
      width: videoPrepared.width,
      height: videoPrepared.height,
      fps: videoPrepared.fps,
      maxBytes,
    });
    const avi = fit.avi;
    log({
      msg:
        `AVI ready — ${formatBytes(avi.length)} (budget ${Math.round(maxBytes / 1024)} KB) · ` +
        `${fit.frameCount} frames @ ${fit.fps} fps q${fit.quality} ` +
        `${videoPrepared.width}×${videoPrepared.height}`,
      level: 'info',
    });
    if (avi.length > maxBytes) {
      log({
        msg: `AVI still over budget (${formatBytes(avi.length)} > ${formatBytes(maxBytes)}) — badge may refuse it`,
        level: 'warn',
      });
    }
    const result = await client.transferFile(avi, {
      fileType: FileType.VIDEO,
      dialType: 1, // AVI (WatchTheme3 fileType 1)
      onProgress: (pct) => {
        bar.style.width = `${pct}%`;
      },
    });
    toast(`Video pushed to ${client.name || 'badge'} (dial31 AVI)`, 'ok');
    log({
      msg: `Video push complete → ${client.name || result.sessionId} ${formatBytes(avi.length)}`,
      level: 'ok',
    });
    $('#mediaIdPill').textContent = 'FitPro dial31 (AVI)';
  } catch (e) {
    toast(e.message, 'err');
    log({ msg: e.message, level: 'err' });
  } finally {
    transferring = false;
    updatePushChecklist();
    setTimeout(() => {
      wrap.hidden = true;
    }, 900);
  }
}

function clearActiveUi() {
  renderSnapshot({
    name: null,
    model: null,
    firmware: null,
    hardware: null,
    software: null,
    manufacturer: null,
    battery: null,
    protocol: null,
    freeStorage: null,
    storageCapacity: null,
    mediaId: null,
  });
  $('#mediaList').innerHTML = '<div class="empty">Connect and refresh to load media.</div>';
  $('#mediaIdPill').textContent = 'Media ID —';
}

function bind() {
  $('#btnConnect').addEventListener('click', () => connect(false));
  $('#btnConnectAny').addEventListener('click', () => connect(true));
  $('#btnAddBadge').addEventListener('click', () => connect(false));
  $('#btnDisconnect').addEventListener('click', () =>
    client.disconnect().then(() => toast('Disconnected', 'ok')),
  );
  $('#btnDisconnectAll').addEventListener('click', () =>
    client.disconnectAll().then(() => toast('All badges disconnected', 'ok')),
  );
  $('#btnRefresh').addEventListener('click', () =>
    client
      .refreshIdentity()
      .then(() => {
        renderSnapshot();
        renderDeviceChips();
        toast('Device info refreshed', 'ok');
      })
      .catch((e) => toast(e.message, 'err')),
  );
  $('#btnPair').addEventListener('click', () =>
    client.pair().catch((e) => toast(e.message, 'err')),
  );
  $('#btnPickImage').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', () => rebuildPreview());
  $('#dialW').addEventListener('change', () => rebuildPreview());
  $('#dialH').addEventListener('change', () => rebuildPreview());
  $('#roundMask').addEventListener('change', () => rebuildPreview());
  $('#btnPush').addEventListener('click', () => pushImage());
  $('#btnPushAll').addEventListener('click', () => pushAll());
  $('#btnPickVideo').addEventListener('click', () => $('#videoInput').click());
  $('#videoInput').addEventListener('change', () => rebuildVideoPreview());
  $('#videoW').addEventListener('change', () => rebuildVideoPreview());
  $('#videoH').addEventListener('change', () => rebuildVideoPreview());
  $('#videoFps').addEventListener('change', () => rebuildVideoPreview());
  $('#videoSeconds').addEventListener('change', () => rebuildVideoPreview());
  $('#videoRound').addEventListener('change', () => rebuildVideoPreview());
  $('#btnPushVideo').addEventListener('click', () => pushVideo());
  $('#btnVideoFreeSpace').addEventListener('click', () => queryVideoFreeSpace());
  $('#btnDialList').addEventListener('click', () => listDials());
  $('#btnDialPresetList').addEventListener('click', () => listPresetDials());
  $('#btnRcspProbe').addEventListener('click', () => rcspProbe());
  $('#btnRcspList').addEventListener('click', () => listFacesRcsp());
  $('#btnRcspReadPath').addEventListener('click', () => downloadPath());
  $('#btnDialDelete').addEventListener('click', () => deleteDial());
  $('#btnDialSwitch').addEventListener('click', () => switchDial());
  $('#btnMediaList').addEventListener('click', () =>
    client.requestMediaList().catch((e) => {
      toast(e.message, 'err');
      log({ msg: e.message, level: 'err' });
    }),
  );
  $('#btnAllocId').addEventListener('click', () =>
    client
      .allocateMediaId()
      .then((id) => {
        $('#mediaIdPill').textContent = `Media ID ${id}`;
        toast(`Allocated ${id}`, 'ok');
      })
      .catch((e) => toast(e.message, 'err')),
  );
  $('#btnClearLog').addEventListener('click', () => {
    $('#activityLog').innerHTML = '';
  });

  client.addEventListener('log', (e) => log(e.detail));
  client.addEventListener('sessions', () => {
    syncConnectionChrome();
    renderDeviceChips();
  });
  client.addEventListener('connection', (e) => {
    syncConnectionChrome();
    renderDeviceChips();
    if (!e.detail.connected && client.sessionCount === 0) {
      clearActiveUi();
    } else {
      renderSnapshot();
    }
  });
  client.addEventListener('snapshot', (e) => {
    if (!e.detail.sessionId || e.detail.sessionId === client.activeId) {
      renderSnapshot(e.detail.snapshot);
    }
    renderDeviceChips();
  });
  client.addEventListener('deviceinfo', () => renderSnapshot());
  client.addEventListener('disinfo', () => renderSnapshot());
  client.addEventListener('battery', () => {
    renderSnapshot();
    renderDeviceChips();
  });
  client.addEventListener('mediaid', (e) => {
    if (!e.detail.sessionId || e.detail.sessionId === client.activeId) {
      $('#mediaIdPill').textContent = `Media ID ${e.detail.mediaId}`;
    }
  });
  client.addEventListener('medialist', (e) => {
    if (!e.detail.sessionId || e.detail.sessionId === client.activeId) {
      renderMediaList(e.detail.items);
    }
  });
  client.addEventListener('preview', () => {
    renderSnapshot();
    updatePushChecklist();
  });
}

function initSupport() {
  const secure = window.isSecureContext;
  if (!secure) {
    setPill($('#blePill'), 'Needs HTTPS (or localhost)', 'err');
    $('#btnConnect').disabled = true;
    $('#btnConnectAny').disabled = true;
    $('#btnAddBadge').disabled = true;
    log({
      msg: 'Insecure context — Web Bluetooth is blocked. Use GitHub Pages HTTPS or localhost.',
      level: 'err',
    });
    return;
  }
  if (SuperBandClient.supported()) {
    setPill($('#blePill'), 'Web Bluetooth ready', 'ok');
  } else {
    setPill($('#blePill'), 'Web Bluetooth unavailable', 'err');
    $('#btnConnect').disabled = true;
    $('#btnConnectAny').disabled = true;
    $('#btnAddBadge').disabled = true;
  }
}

const FALLBACK_VERSION = '2026.08.11.1';

function applyVersionLabel(version, builtAt = null) {
  const hero = $('#appVersion');
  if (hero) hero.textContent = version;

  const el = $('#buildMeta');
  if (!el) return;
  el.innerHTML = '';
  const a = document.createElement('a');
  a.href = REPO_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `SuperBand v${version}`;
  el.appendChild(a);
  if (builtAt) {
    el.appendChild(document.createTextNode(` · ${builtAt}`));
  }
}

async function initBuildMeta() {
  applyVersionLabel(FALLBACK_VERSION);
  try {
    // Site-root version.json (written by Pages / local build), not next to the JS chunk.
    const res = await fetch(new URL('version.json', document.baseURI));
    if (!res.ok) throw new Error('no version');
    const data = await res.json();
    if (data?.version) {
      applyVersionLabel(String(data.version), data.built_at || null);
    }
  } catch {
    // Keep FALLBACK_VERSION from HTML / package.json.
  }
}

bind();
bindAdvanced({ client, log, toast, $ });
bindExtras({ client, log, toast, $ });
initSupport();
initBuildMeta();
syncConnectionChrome();
updatePushChecklist();
log({
  msg: 'SuperBand manager ready. Connect one or more badges (each Add opens the picker). Advanced tab: OTA / GATT / probes.',
  level: 'info',
});
