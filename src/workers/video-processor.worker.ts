import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
  type MPMask,
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
const DEBUG = false;
let frameLogCount = 0;
let maskLogCount = 0;
function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[VBP:worker]', ...args);
}
type WorkerWithImportShim = DedicatedWorkerGlobalScope & {
  import?: (specifier: string) => Promise<unknown>;
  ModuleFactory?: unknown;
  importScripts?: (...urls: string[]) => void;
  custom_dbg?: (...args: unknown[]) => void;
};
const importShimTarget = self as unknown as WorkerWithImportShim;

// Work around a strict-mode bug in MediaPipe's wasm loader where `custom_dbg`
// can be referenced without a guaranteed declaration.
if (typeof importShimTarget.custom_dbg !== 'function') {
  debug('installing custom_dbg shim');
  importShimTarget.custom_dbg = () => {};
}

// MediaPipe's runtime may call `self.import(url)` when `importScripts` is unavailable.
// Module workers do not expose this helper, so we provide a compatible shim.
if (typeof importShimTarget.import !== 'function') {
  debug('installing self.import shim');
  importShimTarget.import = async (specifier: string) => {
    debug('self.import called', specifier);

    // Try module-style import first. This is the correct path in module workers.
    try {
      const imported = await import(/* @vite-ignore */ specifier);
      const importedFactory = (imported as { default?: unknown }).default;
      if (typeof importedFactory === 'function') {
        importShimTarget.ModuleFactory = importedFactory;
        debug('ModuleFactory extracted via dynamic import');
        return importedFactory;
      }
      debug('dynamic import returned non-factory export', { specifier });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      debug('dynamic import path failed; falling back', { specifier, message });
    }

    // Classic worker fallback for non-module scripts.
    if (typeof importShimTarget.importScripts === 'function') {
      try {
        importShimTarget.importScripts(specifier);
        const factory = importShimTarget.ModuleFactory;
        if (typeof factory === 'function') {
          debug('ModuleFactory extracted via importScripts');
          return factory;
        }
        throw new Error(`ModuleFactory not set after importScripts: ${specifier}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        debug('importScripts path failed; falling back', { specifier, message });
      }
    }

    // Last fallback for non-module UMD scripts: fetch + eval to extract ModuleFactory.
    const res = await fetch(specifier);
    if (!res.ok) {
      throw new Error(`Failed to load script: ${specifier} (${res.status})`);
    }
    const source = await res.text();
    const factory = new Function(
      `${source}\nreturn (typeof ModuleFactory !== 'undefined') ? ModuleFactory : undefined;`,
    )();
    if (typeof factory === 'function') {
      importShimTarget.ModuleFactory = factory;
      debug('ModuleFactory extracted and assigned');
      return factory;
    }
    debug('ModuleFactory not found in eval; fallback dynamic import');
    return import(/* @vite-ignore */ specifier);
  };
}

type Nullable<T> = T | null;

// Keep this version aligned with installed @mediapipe/tasks-vision.
const WASM_URL_DEFAULT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
const WASM_USE_MODULE = true;
const SEGMENTER_INIT_TIMEOUT_MS = 45000;

const SELFIE_MODEL_CANDIDATES: string[] = [
  // Prefer dedicated person/selfie models for robust foreground masks.
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  // Generic semantic fallback.
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite',
];

const MULTICLASS_HAIR_MODEL_CANDIDATES: string[] = [
  // Optional enhancement model; keep empty to avoid init failure paths on incompatible model metadata.
];

const INFERENCE_MAX_HEIGHT_PX = 360;
const MASK_HISTORY = 3;
const MIN_SELFIE_INFERENCE_INTERVAL_MS = 66;
const MIN_HAIR_INFERENCE_INTERVAL_MS = 180;
const POLARITY_DETECTION_MAX_SAMPLES = 20;
const POLARITY_DETECTION_MIN_DELTA = 8;

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
let selfiePersonClassIndex: number | null = null;
let selfieMaskKind: 'category' | 'confidence' | null = null;
let selfieCategoryMode: 'class-index' | 'binary-threshold' = 'class-index';
let selfieThresholdForegroundIsHigh = true;
let selfiePolarityVotes = 0;
let selfiePolaritySamples = 0;
let segmentationSkipLogCount = 0;

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
  debug('postError', message);
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

function resetSelfiePolarityDetection(): void {
  selfieThresholdForegroundIsHigh = true;
  selfiePolarityVotes = 0;
  selfiePolaritySamples = 0;
}

function updateSelfieThresholdPolarity(maskValues: Uint8Array, width: number, height: number): void {
  if (selfieCategoryMode !== 'binary-threshold') return;
  if (selfiePolaritySamples >= POLARITY_DETECTION_MAX_SAMPLES) return;
  if (width < 16 || height < 16) return;

  const stride = Math.max(1, Math.floor(Math.min(width, height) / 96));
  const centerX0 = Math.floor(width * 0.30);
  const centerX1 = Math.floor(width * 0.70);
  const centerY0 = Math.floor(height * 0.20);
  const centerY1 = Math.floor(height * 0.88);
  const borderX = Math.floor(width * 0.12);
  const borderY = Math.floor(height * 0.08);

  let centerSum = 0;
  let centerCount = 0;
  let borderSum = 0;
  let borderCount = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const v = maskValues[y * width + x]!;
      const inCenter = x >= centerX0 && x < centerX1 && y >= centerY0 && y < centerY1;
      if (inCenter) {
        centerSum += v;
        centerCount += 1;
      }

      const inBorder = x < borderX || x >= width - borderX || y < borderY || y >= height - borderY;
      if (inBorder) {
        borderSum += v;
        borderCount += 1;
      }
    }
  }

  if (centerCount === 0 || borderCount === 0) return;
  const centerMean = centerSum / centerCount;
  const borderMean = borderSum / borderCount;
  const delta = centerMean - borderMean;
  if (Math.abs(delta) < POLARITY_DETECTION_MIN_DELTA) return;

  selfiePolaritySamples += 1;
  selfiePolarityVotes += delta > 0 ? 1 : -1;

  const nextForegroundHigh = selfiePolarityVotes >= 0;
  if (nextForegroundHigh !== selfieThresholdForegroundIsHigh) {
    selfieThresholdForegroundIsHigh = nextForegroundHigh;
    debug('selfie polarity adjusted', {
      foregroundHigh: selfieThresholdForegroundIsHigh,
      votes: selfiePolarityVotes,
      samples: selfiePolaritySamples,
      centerMean,
      borderMean,
    });
  }
}

function maskValuesToBinaryU8(maskValues: Uint8Array, isForeground: (v: number) => boolean): Uint8Array {
  const count = maskValues.length;
  const out = new Uint8Array(count);
  for (let px = 0; px < count; px++) {
    out[px] = isForeground(maskValues[px]!) ? 255 : 0;
  }
  return out;
}

function submitSegmentationSelfie(maskValues: Uint8Array, width: number, height: number, isCategoryMask: boolean): void {
  if (!selfieSegmenter) return;
  if (maskLogCount < 5) {
    maskLogCount += 1;
    debug('selfie mask received', {
      width,
      height,
      kind: isCategoryMask ? 'category' : 'confidence',
      personClassIndex: selfiePersonClassIndex,
    });
  }
  maskWidth = width;
  maskHeight = height;
  if (selfieCategoryMode === 'binary-threshold') {
    updateSelfieThresholdPolarity(maskValues, width, height);
  }
  const thresholdForeground = (v: number): boolean => (
    selfieThresholdForegroundIsHigh ? v >= 128 : v < 128
  );
  const selfieBinary = isCategoryMask
    ? maskValuesToBinaryU8(maskValues, (v) => {
      if (selfieCategoryMode === 'class-index' && selfiePersonClassIndex !== null) {
        return v === selfiePersonClassIndex;
      }
      // Some selfie models expose a single output label and encode foreground confidence-like
      // values in category mask bytes. Treat as binary mask in that case.
      return thresholdForeground(v);
    })
    : maskValuesToBinaryU8(maskValues, (v) => {
      if (selfieCategoryMode === 'binary-threshold') return thresholdForeground(v);
      return v >= 128;
    });
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

function submitSegmentationHair(categoryMask: Uint8Array): void {
  if (!hairSegmenter) return;
  latestHairMask = maskValuesToBinaryU8(categoryMask, (v) => v > 0);
}

function maybeStartSegmentation(bitmap: ImageBitmap, startTimeMs: number): void {
  if (effect === 'none') return;
  if (!inferenceCtx || !inferenceCanvas) return;
  if (!selfieSegmenter) {
    if (segmentationSkipLogCount < 10) {
      segmentationSkipLogCount += 1;
      debug('segmentation skipped: selfieSegmenter not ready yet', { effect, modelLoadError });
    }
    return;
  }

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
            if (mask) submitSegmentationSelfie(mask.data, mask.width, mask.height, mask.isCategoryMask);
            else if (maskLogCount < 5) debug('selfie mask missing in result');
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
            if (mask) submitSegmentationHair(mask.data);
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

async function createFirstAvailableSegmenter(
  vision: unknown,
  candidates: string[],
): Promise<{ segmenter: ImageSegmenter; url: string } | null> {
  for (const url of candidates) {
    debug('segmenter candidate:try', { url });

    // Attempt 1: direct model URL via createFromOptions.
    try {
      const segmenter = await ImageSegmenter.createFromOptions(vision as never, {
        // CPU delegate is the most robust option in dedicated workers.
        baseOptions: { modelAssetPath: url, delegate: 'CPU' },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'VIDEO',
      });
      debug('segmenter candidate:ok(createFromOptions:path)', { url });
      return { segmenter, url };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      debug('segmenter candidate failed(createFromOptions:path)', { url, message });
    }

    // Attempt 2: createFromModelPath + setOptions.
    try {
      const segmenter = await ImageSegmenter.createFromModelPath(vision as never, url);
      await segmenter.setOptions({
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      debug('segmenter candidate:ok(createFromModelPath)', { url });
      return { segmenter, url };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      debug('segmenter candidate failed(createFromModelPath)', { url, message });
    }

    // Attempt 3: fetch model bytes ourselves and pass modelAssetBuffer.
    try {
      const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const segmenter = await ImageSegmenter.createFromOptions(vision as never, {
        baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'VIDEO',
      });
      debug('segmenter candidate:ok(createFromOptions:buffer)', { url, bytes: bytes.length });
      return { segmenter, url };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      debug('segmenter candidate failed(createFromOptions:buffer)', { url, message });
    }
  }
  return null;
}

async function initSegmenters(): Promise<void> {
  try {
    debug('initSegmenters:start');
    debug('initSegmenters:forVisionTasks:begin', { wasmUrl: WASM_URL_DEFAULT, useModule: WASM_USE_MODULE });
    const vision = await FilesetResolver.forVisionTasks(WASM_URL_DEFAULT, WASM_USE_MODULE);
    debug('initSegmenters:forVisionTasks:ok', { wasmUrl: WASM_URL_DEFAULT, useModule: WASM_USE_MODULE });
    const selfie = await createFirstAvailableSegmenter(vision, SELFIE_MODEL_CANDIDATES);
    if (!selfie) {
      throw new Error('No working selfie segmentation model URL');
    }
    selfieSegmenter = selfie.segmenter;
    debug('initSegmenters:selfieCreate:ok', selfie.url);
    const labels = selfieSegmenter.getLabels();
    const personIdx = labels.findIndex((l) => l.toLowerCase() === 'person' || l.toLowerCase().includes('person'));
    if (personIdx >= 0) {
      selfiePersonClassIndex = personIdx;
      selfieCategoryMode = 'class-index';
    } else if (labels.length <= 1) {
      // Single-label selfie models usually behave like binary confidence masks.
      selfiePersonClassIndex = null;
      selfieCategoryMode = 'binary-threshold';
    } else {
      // Unknown label schema: prefer threshold mode over brittle hardcoded class IDs.
      selfiePersonClassIndex = null;
      selfieCategoryMode = 'binary-threshold';
    }
    resetSelfiePolarityDetection();
    segmentationSkipLogCount = 0;
    debug('initSegmenters:selfieLabels', {
      count: labels.length,
      personIndex: selfiePersonClassIndex,
      categoryMode: selfieCategoryMode,
      thresholdForegroundHigh: selfieThresholdForegroundIsHigh,
      sample: labels.slice(0, 8),
    });
    debug('initSegmenters:hairCreate:begin');
    const hair = await createFirstAvailableSegmenter(vision, MULTICLASS_HAIR_MODEL_CANDIDATES);
    if (hair) {
      hairSegmenter = hair.segmenter;
      debug('initSegmenters:hairCreate:ok', hair.url);
    } else {
      debug('initSegmenters:hairCreate:skip(no model)');
    }
    debug('initSegmenters:success', {
      selfieLoaded: Boolean(selfieSegmenter),
      hairLoaded: Boolean(hairSegmenter),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to load segmentation models';
    modelLoadError = msg;
    debug('initSegmenters:failed', msg);
    throw err;
  }
}

async function handleInit(msg: VirtualBackgroundWorkerMessage & { type: 'init' }): Promise<void> {
  debug('handleInit', { width: msg.width, height: msg.height });
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
  // Unblock main thread frame flow immediately; model loading can happen in background.
  debug('posting ready');
  postMessageSafe({ type: 'ready' });

  void (async () => {
    try {
      await Promise.race([
        initSegmenters(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Segmenter init timeout after ${SEGMENTER_INIT_TIMEOUT_MS}ms`)), SEGMENTER_INIT_TIMEOUT_MS);
        }),
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Model load failed';
      // Keep passthrough rendering alive even if segmenter initialization stalls/fails.
      debug('segmenter init warning', message);
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
  if (frameLogCount < 5) {
    frameLogCount += 1;
    debug('renderFrameInternal', { effect, blurStrength, timestampMs, maskReady });
  }
  maybeStartSegmentation(bitmap, timestampMs);
}

function handleBackgroundImage(bitmap: ImageBitmap | null): void {
  compositor?.setBackgroundImage(bitmap);
}

function extractMaskFromResult(
  result: ImageSegmenterResult,
): { data: Uint8Array; width: number; height: number; isCategoryMask: boolean } | null {
  const maybeMask = (result as unknown as { categoryMask?: MPMask | ImageData }).categoryMask;
  if (maybeMask) {
    if (typeof (maybeMask as MPMask).getAsUint8Array === 'function') {
      const mpMask = maybeMask as MPMask;
      const width = mpMask.width;
      const height = mpMask.height;
      if (width <= 0 || height <= 0) return null;
      // Copy because callback-backed buffers are ephemeral.
      const data = new Uint8Array(mpMask.getAsUint8Array());
      mpMask.close();
      selfieMaskKind = 'category';
      return { data, width, height, isCategoryMask: true };
    }

    if (maybeMask instanceof ImageData) {
      const width = maybeMask.width;
      const height = maybeMask.height;
      if (width <= 0 || height <= 0) return null;
      const rgba = maybeMask.data;
      const data = new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) {
        data[i] = rgba[i * 4]!;
      }
      selfieMaskKind = 'category';
      return { data, width, height, isCategoryMask: true };
    }
  }

  // Fallback to confidence mask when category mask is not available for this model/runtime combo.
  const confidenceMasks = (result as unknown as { confidenceMasks?: MPMask[] }).confidenceMasks;
  if (confidenceMasks && confidenceMasks.length > 0) {
    let idx = 0;
    if (selfiePersonClassIndex !== null && selfiePersonClassIndex >= 0 && selfiePersonClassIndex < confidenceMasks.length) {
      idx = selfiePersonClassIndex;
    } else if (confidenceMasks.length > 1) {
      idx = 1;
    }
    const confidence = confidenceMasks[idx]!;
    const width = confidence.width;
    const height = confidence.height;
    if (width <= 0 || height <= 0) return null;
    const f32 = confidence.getAsFloat32Array();
    const data = new Uint8Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(0, Math.min(1, f32[i]!));
      data[i] = Math.round(v * 255);
    }
    confidence.close();
    selfieMaskKind = 'confidence';
    return { data, width, height, isCategoryMask: false };
  }

  return null;
}

ctx.onmessage = (e: MessageEvent<VirtualBackgroundWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      debug('message:init');
      void handleInit(msg);
      return;
    }

    if (msg.type === 'setEffect') {
      debug('message:setEffect', { effect: msg.effect, blurStrength: msg.blurStrength });
      effect = msg.effect;
      blurStrength = Math.max(0, Math.min(30, msg.blurStrength));
      if (effect === 'none') {
        resetMaskHistory();
      }
      return;
    }

    if (msg.type === 'setBackgroundImage') {
      debug('message:setBackgroundImage', { hasBitmap: Boolean(msg.bitmap) });
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
      if (frameLogCount < 5) {
        debug('message:frame', { frameId: msg.frameId, timestampMs: msg.timestampMs });
      }
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
