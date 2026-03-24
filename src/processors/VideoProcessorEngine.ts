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
  private worker: Worker | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private processedStream: MediaStream | null = null;

  private running = false;
  private ready = false;
  private pendingBitmap = false;
  private frameId = 0;
  private videoFrameCbHandle: number | null = null;

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

    this.worker.onmessage = (e: MessageEvent<VirtualBackgroundWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
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
        this.ready = false;
        this.pendingBitmap = false;
        this.emitError(msg.message);
        return;
      }

      if (msg.type === 'frameRendered') {
        this.pendingBitmap = false;

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

    return this.processedStream;
  }

  stop(): void {
    this.running = false;
    this.ready = false;
    this.pendingBitmap = false;

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
    for (const l of this.errorListeners) l(message);
  }

  private postSetEffect(): void {
    if (!this.worker) return;
    const msg: VirtualBackgroundWorkerMessage = {
      type: 'setEffect',
      effect: this.effect,
      blurStrength: this.blurStrength,
    };
    this.worker.postMessage(msg);
  }

  private async postBackgroundImageFromAsset(asset: BackgroundImageAsset): Promise<void> {
    const canvasEl = this.canvasEl;
    if (!canvasEl) return;
    if (!this.worker) return;

    // Decode off the main rendering path (async).
    const img = new Image();
    img.src = asset.objectUrl;
    await img.decode();

    const bitmap = await createImageBitmap(img);
    const msg: VirtualBackgroundWorkerMessage = {
      type: 'setBackgroundImage',
      bitmap,
    };
    this.worker.postMessage(msg, [bitmap]);
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

      if (!this.ready) return;
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

