import { FpsCounter } from '@/utils/fps-counter';
import type {
  BackgroundImageAsset,
  VirtualBackgroundEffect,
  VirtualBackgroundWorkerResponse,
  VirtualBackgroundWorkerMessage,
} from '@/types/video-processing';
import type { FrameTelemetry } from '@/types/video-processing';

// Live test URL: http://localhost:5173

export interface VideoProcessorEngineOptions {
  effect: VirtualBackgroundEffect;
  blurStrength: number; // 0..30
  backgroundImage: BackgroundImageAsset | null;
}

export interface VideoProcessorTelemetry {
  fps: number;
  latencyMs: number;
}

export class VideoProcessorEngine {
  private static readonly DEBUG = false;
  private worker: Worker | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private processedStream: MediaStream | null = null;

  private running = false;
  private ready = false;
  private pendingBitmap = false;
  private frameId = 0;
  private videoFrameCbHandle: number | null = null;
  private framePostedLogCount = 0;
  private frameRenderedLogCount = 0;
  private noReadyLogCount = 0;
  private setEffectPostTimeoutId: number | null = null;
  private pendingSetEffect: { effect: VirtualBackgroundEffect; blurStrength: number } | null = null;

  private effect: VirtualBackgroundEffect;
  private blurStrength: number;
  private backgroundImage: BackgroundImageAsset | null;

  private telemetry: FrameTelemetry = {
    fps: 0,
    frameTimeMs: 0,
    latencyMs: 0,
    droppedFrames: 0,
  };

  private readonly fpsCounter = new FpsCounter(1000);

  private telemetryListeners: Array<(t: VideoProcessorTelemetry) => void> = [];
  private errorListeners: Array<(message: string) => void> = [];

  constructor(initial: VideoProcessorEngineOptions) {
    this.effect = initial.effect;
    this.blurStrength = this.clampBlurStrength(initial.blurStrength);
    this.backgroundImage = initial.backgroundImage;
  }

  private debug(...args: unknown[]): void {
    if (!VideoProcessorEngine.DEBUG) return;
    // eslint-disable-next-line no-console
    console.log('[VBP:main]', ...args);
  }

  onTelemetry(listener: (t: VideoProcessorTelemetry) => void): () => void {
    this.telemetryListeners.push(listener);
    return () => {
      this.telemetryListeners = this.telemetryListeners.filter((l) => l !== listener);
    };
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }

  getProcessedStream(): MediaStream | null {
    return this.processedStream;
  }

  async start(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): Promise<MediaStream> {
    if (this.running) return this.processedStream ?? new MediaStream();
    this.running = true;
    this.ready = false;
    this.pendingBitmap = false;
    this.frameId = 0;

    this.videoEl = videoEl;
    this.canvasEl = canvasEl;

    const width = videoEl.videoWidth;
    const height = videoEl.videoHeight;
    if (!width || !height) throw new Error('Video dimensions not available yet');
    this.debug('start()', { width, height, effect: this.effect, blur: this.blurStrength });

    // Ensure output is at original resolution.
    canvasEl.width = width;
    canvasEl.height = height;

    // Capture stream from the canvas output surface.
    const fps = this.getInputTrackFrameRate(videoEl) ?? 30;
    this.processedStream = canvasEl.captureStream(fps);

    const offscreen = canvasEl.transferControlToOffscreen();

    this.worker = new Worker(new URL('../workers/video-processor.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.debug('worker created');

    this.worker.onmessage = (e: MessageEvent<VirtualBackgroundWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        this.debug('worker ready');
        this.ready = true;
        // Push current settings immediately after worker is ready.
        this.postSetEffect();
        if (this.backgroundImage) {
          void this.postBackgroundImageFromAsset(this.backgroundImage);
        }
        this.startVideoFrameCallback();
        return;
      }

      if (msg.type === 'error') {
        this.debug('worker error message', msg.message);
        this.ready = false;
        this.pendingBitmap = false;
        this.emitError(msg.message);
        return;
      }

      if (msg.type === 'frameRendered') {
        this.pendingBitmap = false;
        if (this.frameRenderedLogCount < 5) {
          this.frameRenderedLogCount += 1;
          this.debug('frameRendered', { frameId: msg.frameId, latencyMs: msg.latencyMs });
        }

        const nowMs = performance.now();
        const sample = this.fpsCounter.tick(nowMs);
        this.telemetry.fps = sample.fps;
        this.telemetry.frameTimeMs = msg.latencyMs;
        this.telemetry.latencyMs = msg.latencyMs;

        const t: VideoProcessorTelemetry = { fps: this.telemetry.fps, latencyMs: this.telemetry.latencyMs };
        for (const l of this.telemetryListeners) l(t);
      }
    };

    this.worker.onerror = () => {
      this.debug('worker onerror');
      this.pendingBitmap = false;
      this.ready = false;
      this.emitError('Video processor worker crashed');
    };

    const initMsg: VirtualBackgroundWorkerMessage = {
      type: 'init',
      canvas: offscreen,
      width,
      height,
      devicePixelRatio: window.devicePixelRatio || 1,
    };

    // Transfer OffscreenCanvas to the worker.
    this.worker.postMessage(initMsg, [offscreen]);
    this.debug('init posted to worker');

    return this.processedStream;
  }

  stop(): void {
    this.debug('stop()');
    this.running = false;
    this.ready = false;
    this.pendingBitmap = false;
    this.pendingSetEffect = null;
    if (this.setEffectPostTimeoutId !== null) {
      window.clearTimeout(this.setEffectPostTimeoutId);
      this.setEffectPostTimeoutId = null;
    }

    if (this.videoEl && this.videoFrameCbHandle !== null) {
      try {
        this.videoEl.cancelVideoFrameCallback(this.videoFrameCbHandle);
      } catch {
        // Ignore; some browsers may not support cancel.
      }
    }

    this.videoFrameCbHandle = null;
    this.videoEl = null;

    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore.
      }
    }
    this.worker = null;

    this.processedStream = null;
    this.canvasEl = null;
  }

  setEffect(effect: VirtualBackgroundEffect, blurStrength?: number): void {
    this.effect = effect;
    if (typeof blurStrength === 'number') {
      this.blurStrength = this.clampBlurStrength(blurStrength);
    }
    this.postSetEffect();
  }

  setBackgroundImage(asset: BackgroundImageAsset | null): void {
    this.backgroundImage = asset;
    if (!this.worker) return;
    if (!asset) {
      const msg: VirtualBackgroundWorkerMessage = {
        type: 'setBackgroundImage',
        bitmap: null,
      };
      this.worker.postMessage(msg);
      return;
    }
    void this.postBackgroundImageFromAsset(asset);
  }

  private clampBlurStrength(value: number): number {
    return Math.max(0, Math.min(30, value));
  }

  private emitError(message: string): void {
    this.debug('emitError()', message);
    for (const l of this.errorListeners) l(message);
  }

  private postSetEffect(): void {
    if (!this.worker) return;
    this.pendingSetEffect = {
      effect: this.effect,
      blurStrength: this.blurStrength,
    };

    if (this.setEffectPostTimeoutId !== null) return;

    // Coalesce rapid slider changes into a single post per frame-ish tick.
    this.setEffectPostTimeoutId = window.setTimeout(() => {
      this.setEffectPostTimeoutId = null;
      const worker = this.worker;
      const pending = this.pendingSetEffect;
      this.pendingSetEffect = null;
      if (!worker || !pending) return;
      const msg: VirtualBackgroundWorkerMessage = {
        type: 'setEffect',
        effect: pending.effect,
        blurStrength: pending.blurStrength,
      };
      worker.postMessage(msg);
      this.debug('setEffect posted', msg);
    }, 16);
  }

  private async postBackgroundImageFromAsset(asset: BackgroundImageAsset): Promise<void> {
    const canvasEl = this.canvasEl;
    if (!canvasEl) return;
    if (!this.worker) return;

    // Decode off the main rendering path (async).
    const img = new Image();
    img.src = asset.objectUrl;
    await img.decode();

    const targetWidth = Math.max(2, canvasEl.width);
    const targetHeight = Math.max(2, canvasEl.height);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(img, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'high',
      });
    } catch {
      // Fallback for environments that do not support resize options.
      bitmap = await createImageBitmap(img);
    }
    const msg: VirtualBackgroundWorkerMessage = {
      type: 'setBackgroundImage',
      bitmap,
    };
    this.worker.postMessage(msg, [bitmap]);
    this.debug('background image posted to worker', { name: asset.name });
  }

  private getInputTrackFrameRate(videoEl: HTMLVideoElement): number | null {
    const srcObject = videoEl.srcObject;
    if (!srcObject) return null;
    const tracks = srcObject.getVideoTracks();
    if (tracks.length === 0) return null;
    const rate = tracks[0]?.getSettings().frameRate;
    if (!rate || !Number.isFinite(rate)) return null;
    return Math.max(1, Math.round(rate));
  }

  private startVideoFrameCallback(): void {
    const videoEl = this.videoEl;
    const worker = this.worker;
    if (!videoEl || !worker) return;

    const tick = async (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!this.running) return;

      // Schedule next callback immediately (no blocking in callback).
      try {
        this.videoFrameCbHandle = videoEl.requestVideoFrameCallback(tick);
      } catch {
        // If requestVideoFrameCallback fails, stop the loop.
        this.videoFrameCbHandle = null;
        return;
      }

      if (!this.ready) {
        if (this.noReadyLogCount < 3) {
          this.noReadyLogCount += 1;
          this.debug('tick skipped: worker not ready yet');
        }
        return;
      }
      if (this.pendingBitmap) return;

      const startTimeMs = Number.isFinite(metadata.mediaTime)
        ? metadata.mediaTime * 1000
        : now;

      // Create transferable ImageBitmap at the exact vsync boundary.
      // (This promise is non-blocking; we only enqueue a single in-flight frame.)
      this.pendingBitmap = true;
      void createImageBitmap(videoEl)
        .then((bitmap) => {
          if (!this.running || !this.worker) {
            bitmap.close();
            return;
          }
          const frameId = ++this.frameId;
          const msg: VirtualBackgroundWorkerMessage = {
            type: 'frame',
            bitmap,
            frameId,
            timestampMs: startTimeMs,
          };
          this.worker.postMessage(msg, [bitmap]);
          if (this.framePostedLogCount < 5) {
            this.framePostedLogCount += 1;
            this.debug('frame posted', { frameId, timestampMs: startTimeMs });
          }
        })
        .catch((err: unknown) => {
          this.pendingBitmap = false;
          const msg = err instanceof Error ? err.message : 'Failed to create ImageBitmap';
          this.emitError(msg);
        });
    };

    this.videoFrameCbHandle = videoEl.requestVideoFrameCallback(tick);
  }
}

