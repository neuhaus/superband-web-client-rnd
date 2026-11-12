/**
 * Turn a GIF / APNG / WebP (animated image) or a video file into JPEG frames,
 * then build an MJPG AVI for FitPro dial push (see ./avi.js).
 *
 * - Animated images: `ImageDecoder` (Chrome 94+), which handles GIF/WebP/APNG
 *   frame timing natively.
 * - Video files: a hidden `<video>` element, seeking at a fixed frame rate.
 *   Codec support is whatever the browser can play (H.264 MP4 works in Chrome).
 */

import { buildMjpgAvi, DEFAULT_AVI } from './avi.js';

export const WATCH_VIDEO = {
  fps: 12,
  /** Clamp captured animation length (seconds). */
  maxSeconds: 3,
  /** JPEG quality per frame. */
  quality: 0.6,
  /** Hard cap on frame count (upload size guard). */
  maxFrames: 96,
};

const ANIMATED_EXT = /\.(gif|webp|apng|avif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|avi|mkv|wmv|flv|3gp)$/i;

function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function isAnimatedImage(file) {
  const type = (file?.type || '').toLowerCase();
  return (
    /^image\/(gif|webp|apng|avif)/.test(type) || ANIMATED_EXT.test(file?.name || '')
  );
}

export function isSupportedVideoFile(file) {
  const type = (file?.type || '').toLowerCase();
  return isAnimatedImage(file) || /^video\//.test(type) || VIDEO_EXT.test(file?.name || '');
}

function detectAnimatedMime(name) {
  const map = { gif: 'image/gif', webp: 'image/webp', apng: 'image/apng', avif: 'image/avif' };
  return map[extOf(name)] || 'image/gif';
}

/** Cover-crop `source` into the target size, optional round mask. */
function drawCover(ctx, source, sw, sh, width, height, round) {
  if (!sw || !sh) return;
  const scale = Math.max(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (round) {
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, dx, dy, dw, dh);
  ctx.restore();
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('JPEG encode failed'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

async function extractAnimatedImage(file, cfg, onProgress) {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error(
      'This browser lacks ImageDecoder — use Chrome/Edge for GIF/WebP, or push an MP4/H.264 video.',
    );
  }
  const data = await file.arrayBuffer();
  const type = file.type && /image\//.test(file.type) ? file.type : detectAnimatedMime(file.name);
  const decoder = new ImageDecoder({ data, type });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track?.frameCount || 1;
    const budget = Math.max(
      1,
      Math.min(cfg.maxFrames, Math.round(cfg.fps * cfg.maxSeconds), frameCount),
    );

    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const ctx = canvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < budget; i++) {
      const idx =
        frameCount > 1
          ? Math.min(frameCount - 1, Math.round((i / budget) * frameCount))
          : 0;
      const { image } = await decoder.decode({ frameIndex: idx, completeFramesOnly: true });
      drawCover(ctx, image, image.displayWidth, image.displayHeight, cfg.width, cfg.height, cfg.round);
      image.close?.();
      frames.push(await canvasToJpeg(canvas, cfg.quality));
      onProgress?.((i + 1) / budget);
    }
    return {
      frames,
      previewUrl: canvas.toDataURL('image/png'),
      source: 'animated-image',
      sourceFrames: frameCount,
    };
  } finally {
    decoder.close?.();
  }
}

function seekVideo(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    video.addEventListener('seeked', finish);
    try {
      const dur = Number.isFinite(video.duration) ? video.duration : t + 0.001;
      video.currentTime = Math.min(t, Math.max(0, dur - 0.001));
    } catch {
      finish();
    }
  });
}

async function extractVideoFile(file, cfg, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Failed to decode video (unsupported codec?)'));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : cfg.maxSeconds;
    const span = Math.min(duration || cfg.maxSeconds, cfg.maxSeconds);
    const budget = Math.max(1, Math.min(cfg.maxFrames, Math.round(cfg.fps * span)));

    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const ctx = canvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < budget; i++) {
      const t = budget > 1 ? (i / budget) * span : 0;
      await seekVideo(video, t);
      drawCover(ctx, video, video.videoWidth, video.videoHeight, cfg.width, cfg.height, cfg.round);
      frames.push(await canvasToJpeg(canvas, cfg.quality));
      onProgress?.((i + 1) / budget);
    }
    return {
      frames,
      previewUrl: canvas.toDataURL('image/png'),
      source: 'video',
      duration: span,
    };
  } finally {
    video.removeAttribute('src');
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode a GIF/animated image or video into JPEG frames for the badge.
 * @param {File} file
 * @param {{width?:number,height?:number,fps?:number,maxSeconds?:number,quality?:number,round?:boolean,maxFrames?:number}} [opts]
 * @param {(fraction:number)=>void} [onProgress]
 */
export async function extractFramesForBadge(file, opts = {}, onProgress) {
  const cfg = {
    width: opts.width ?? DEFAULT_AVI.width,
    height: opts.height ?? DEFAULT_AVI.height,
    fps: opts.fps ?? WATCH_VIDEO.fps,
    maxSeconds: opts.maxSeconds ?? WATCH_VIDEO.maxSeconds,
    quality: opts.quality ?? WATCH_VIDEO.quality,
    round: opts.round ?? false,
    maxFrames: opts.maxFrames ?? WATCH_VIDEO.maxFrames,
  };
  if (isAnimatedImage(file)) return extractAnimatedImage(file, cfg, onProgress);
  return extractVideoFile(file, cfg, onProgress);
}

/**
 * Build the MJPG AVI bytes for a set of decoded frames.
 * @param {Array<Uint8Array>} frames
 * @param {{width:number,height:number,fps:number}} opts
 */
export function buildAviFromFrames(frames, opts) {
  return buildMjpgAvi(frames, opts);
}
