import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision';
import { WebGLCompositor, type FaceBox } from '@/processors/WebGLCompositor';
import type {
  VirtualBackgroundEffect,
  VirtualBackgroundWorkerMessage,
  VirtualBackgroundWorkerResponse,
} from '@/types/video-processing';

// Live test URL: http://localhost:5173

type Offscreen2DContext = OffscreenCanvasRenderingContext2D;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

type Nullable<T> = T | null;

const WASM_URL_DEFAULT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';

const SELFIE_MODEL_CANDIDATES: string[] = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmenter_landscape.tflite',
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation_landscape.tflite',
];

const MULTICLASS_HAIR_MODEL_CANDIDATES: string[] = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_multiclass_segmenter_landscape.tflite',
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation_multiclass_landscape.tflite',
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_multiclass_segmentation_landscape.tflite',
];

const INFERENCE_MAX_HEIGHT_PX = 480;
const MASK_HISTORY = 3;
const MIN_SELFIE_INFERENCE_INTERVAL_MS = 40;
const MIN_HAIR_INFERENCE_INTERVAL_MS = 120;

let effect: VirtualBackgroundEffect = 'none';
let blurStrength = 10;

let canvas: Nullable<OffscreenCanvas> = null;
let compositor: Nullable<WebGLCompositor> = null;

let fullWidth = 0;
let fullHeight = 0;

let inferenceCanvas: Nullable<OffscreenCanvas> = null;
let inferenceCtx: Nullable<Offscreen2DContext> = null;
let inferenceWidth = 0;
let inferenceHeight = 0;

let selfieSegmenter: Nullable<ImageSegmenter> = null;
let hairSegmenter: Nullable<ImageSegmenter> = null;
let modelLoadError: Nullable<string> = null;

let segSelfieInFlight = false;
let segHairInFlight = false;
let lastSelfieInferenceAt = 0;
let lastHairInferenceAt = 0;

let maskRing: [Nullable<Uint8Array>, Nullable<Uint8Array>, Nullable<Uint8Array>] = [null, null, null];
let maskRingIndex = 0;
let maskRingCount = 0;
let maskAvg: Nullable<Uint8Array> = null;
let latestHairMask: Nullable<Uint8Array> = null;
let maskReady = false;
let maskWidth = 0;
let maskHeight = 0;

function postMessageSafe(payload: VirtualBackgroundWorkerResponse): void {
  ctx.postMessage(payload);
}

function postError(message: string, stack?: string): void {
  postMessageSafe({ type: 'error', message, stack });
}

function ensureInferenceCanvas(): void {
  if (inferenceCanvas && inferenceWidth > 0 && inferenceHeight > 0) return;
  const aspect = fullWidth / fullHeight;
  inferenceHeight = INFERENCE_MAX_HEIGHT_PX;
  inferenceWidth = Math.max(2, Math.round(inferenceHeight * aspect));
  inferenceCanvas = new OffscreenCanvas(inferenceWidth, inferenceHeight);
  inferenceCtx = inferenceCanvas.getContext('2d', { willReadFrequently: true }) as Nullable<Offscreen2DContext>;
  if (!inferenceCtx) throw new Error('Failed to create inference 2D context');
}

function estimateFaceBox(mask: Uint8Array, width: number, height: number): FaceBox | null {
  if (width <= 0 || height <= 0) return null;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  const threshold = 48;
  for (let idx = 0; idx < mask.length; idx++) {
    if (mask[idx]! < threshold) continue;
    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    found = true;
  }
  if (!found) return null;
  return {
    x0: Math.max(0, minX / width),
    y0: Math.max(0, minY / height),
    x1: Math.min(1, (maxX + 1) / width),
    y1: Math.min(1, (maxY + 1) / height),
  };
}

function notifyMaskUpdated(): void {
  if (!maskAvg || maskWidth <= 0 || maskHeight <= 0) return;
  if (!compositor) return;
  compositor.updateMask(maskAvg, maskWidth, maskHeight);
  const box = estimateFaceBox(maskAvg, maskWidth, maskHeight);
  compositor.setFaceBox(box);
  maskReady = true;
}

function resetMaskHistory(): void {
  maskRing = [null, null, null];
  maskRingIndex = 0;
  maskRingCount = 0;
  maskAvg = null;
  latestHairMask = null;
  maskReady = false;
  maskWidth = 0;
  maskHeight = 0;
  compositor?.setFaceBox(null);
}

function updateRingWithMask(maskU8: Uint8Array): void {
  if (!maskAvg) {
    maskAvg = new Uint8Array(maskU8.length);
  }
  if (!maskRing[0] || !maskRing[1] || !maskRing[2]) {
    maskRing = [
      new Uint8Array(maskU8.length),
      new Uint8Array(maskU8.length),
      new Uint8Array(maskU8.length),
    ];
  }

  maskRing[maskRingIndex] = maskU8;
  maskRingIndex = (maskRingIndex + 1) % MASK_HISTORY;
  maskRingCount = Math.min(MASK_HISTORY, maskRingCount + 1);

  const count = maskRingCount;
  for (let i = 0; i < maskU8.length; i++) {
    let sum = 0;
    for (let k = 0; k < MASK_HISTORY; k++) {
      const b = maskRing[k];
      if (!b) continue;
      sum += b[i]!;
    }
    maskAvg![i] = Math.round(sum / count);
  }

  notifyMaskUpdated();
}

function categoryMaskToBinaryU8(categoryMask: ImageData, isForeground: (v: number) => boolean): Uint8Array {
  const count = categoryMask.width * categoryMask.height;
  const data = categoryMask.data;
  const out = new Uint8Array(count);
  for (let px = 0; px < count; px++) {
    const r = data[px * 4]!;
    out[px] = isForeground(r) ? 255 : 0;
  }
  return out;
}

function submitSegmentationSelfie(categoryMask: ImageData): void {
  if (!selfieSegmenter) return;
  maskWidth = categoryMask.width;
  maskHeight = categoryMask.height;
  const selfieBinary = categoryMaskToBinaryU8(categoryMask, (v) => v > 0);
  if (!latestHairMask) {
    updateRingWithMask(selfieBinary);
    return;
  }
  const combined = new Uint8Array(selfieBinary.length);
  for (let i = 0; i < combined.length; i++) {
    combined[i] = Math.max(selfieBinary[i]!, latestHairMask[i]!);
  }
  updateRingWithMask(combined);
}

function submitSegmentationHair(categoryMask: ImageData): void {
  if (!hairSegmenter) return;
  latestHairMask = categoryMaskToBinaryU8(categoryMask, (v) => v > 0);
}

function maybeStartSegmentation(bitmap: ImageBitmap, startTimeMs: number): void {
  if (effect === 'none') return;
  if (!inferenceCtx || !inferenceCanvas) return;
  if (!selfieSegmenter) return;

  inferenceCtx.clearRect(0, 0, inferenceWidth, inferenceHeight);
  inferenceCtx.drawImage(bitmap, 0, 0, inferenceWidth, inferenceHeight);

  const now = performance.now();

  if (!segSelfieInFlight && now - lastSelfieInferenceAt >= MIN_SELFIE_INFERENCE_INTERVAL_MS) {
    segSelfieInFlight = true;
    lastSelfieInferenceAt = now;
    try {
      selfieSegmenter.segmentForVideo(
        inferenceCanvas as unknown as HTMLVideoElement,
        startTimeMs,
        (res) => {
          try {
            const mask = extractMaskFromResult(res);
            if (mask) submitSegmentationSelfie(mask);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Selfie segmentation failed';
            postError(msg, err instanceof Error ? err.stack : undefined);
          } finally {
            segSelfieInFlight = false;
          }
        },
      );
    } catch (err: unknown) {
      segSelfieInFlight = false;
      const msg = err instanceof Error ? err.message : 'Selfie segmentForVideo call failed';
      postError(msg, err instanceof Error ? err.stack : undefined);
    }
  }

  if (hairSegmenter && !segHairInFlight && now - lastHairInferenceAt >= MIN_HAIR_INFERENCE_INTERVAL_MS) {
    segHairInFlight = true;
    lastHairInferenceAt = now;
    try {
      hairSegmenter.segmentForVideo(
        inferenceCanvas as unknown as HTMLVideoElement,
        startTimeMs,
        (res) => {
          try {
            const mask = extractMaskFromResult(res);
            if (mask) submitSegmentationHair(mask);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Hair segmentation failed';
            postError(msg, err instanceof Error ? err.stack : undefined);
          } finally {
            segHairInFlight = false;
          }
        },
      );
    } catch (err: unknown) {
      segHairInFlight = false;
      const msg = err instanceof Error ? err.message : 'Hair segmentForVideo call failed';
      postError(msg, err instanceof Error ? err.stack : undefined);
    }
  }
}

async function loadFirstAvailableModel(vision: unknown, candidates: string[]): Promise<string | null> {
  for (const url of candidates) {
    try {
      await ImageSegmenter.createFromOptions(vision as never, {
        baseOptions: { modelAssetPath: url },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'VIDEO',
      });
      return url;
    } catch {
      // Try next
    }
  }
  return null;
}

async function initSegmenters(): Promise<void> {
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL_DEFAULT);
    const selfieUrl =
      (await loadFirstAvailableModel(vision, SELFIE_MODEL_CANDIDATES)) ?? SELFIE_MODEL_CANDIDATES[0]!;
    selfieSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: selfieUrl },
      outputCategoryMask: true,
      outputConfidenceMasks: false,
      runningMode: 'VIDEO',
    });
    const hairUrl = await loadFirstAvailableModel(vision, MULTICLASS_HAIR_MODEL_CANDIDATES);
    if (hairUrl) {
      hairSegmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: hairUrl },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'VIDEO',
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to load segmentation models';
    modelLoadError = msg;
    throw err;
  }
}

async function handleInit(msg: VirtualBackgroundWorkerMessage & { type: 'init' }): Promise<void> {
  canvas = msg.canvas;
  fullWidth = msg.width;
  fullHeight = msg.height;
  ensureInferenceCanvas();
  if (canvas) {
    compositor = new WebGLCompositor({
      canvas,
      width: fullWidth,
      height: fullHeight,
      maskWidth: inferenceWidth,
      maskHeight: inferenceHeight,
    });
  }
  resetMaskHistory();

  void (async () => {
    try {
      await initSegmenters();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Model load failed';
      postError(message, err instanceof Error ? err.stack : undefined);
    } finally {
      postMessageSafe({ type: 'ready' });
    }
  })();
}

function renderFrameInternal(bitmap: ImageBitmap, timestampMs: number): void {
  if (!compositor) return;
  if (maskReady && maskAvg) {
    const faceBox = estimateFaceBox(maskAvg, maskWidth, maskHeight);
    compositor.setFaceBox(faceBox);
  } else {
    compositor.setFaceBox(null);
  }
  compositor.render(bitmap, { effect, blurStrength });
  maybeStartSegmentation(bitmap, timestampMs);
}

function handleBackgroundImage(bitmap: ImageBitmap | null): void {
  compositor?.setBackgroundImage(bitmap);
}

function extractMaskFromResult(result: ImageSegmenterResult): ImageData | null {
  const maybeMask = (result as unknown as { categoryMask?: ImageData }).categoryMask;
  if (!maybeMask || maybeMask.width <= 0 || maybeMask.height <= 0) return null;
  return maybeMask;
}

ctx.onmessage = (e: MessageEvent<VirtualBackgroundWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      void handleInit(msg);
      return;
    }

    if (msg.type === 'setEffect') {
      effect = msg.effect;
      blurStrength = Math.max(0, Math.min(30, msg.blurStrength));
      if (effect === 'none') {
        resetMaskHistory();
      }
      return;
    }

    if (msg.type === 'setBackgroundImage') {
      if (!msg.bitmap) {
        handleBackgroundImage(null);
        return;
      }
      try {
        handleBackgroundImage(msg.bitmap);
      } finally {
        msg.bitmap.close();
      }
      return;
    }

    if (msg.type === 'frame') {
      if (!compositor) {
        msg.bitmap.close();
        return;
      }

      const start = performance.now();
      try {
        renderFrameInternal(msg.bitmap, msg.timestampMs);
      } finally {
        msg.bitmap.close();
      }

      const end = performance.now();
      postMessageSafe({
        type: 'frameRendered',
        frameId: msg.frameId,
        latencyMs: end - start,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Worker error';
    postError(message, err instanceof Error ? err.stack : undefined);
  }
};
