export type VirtualBackgroundEffect = 'none' | 'blur' | 'image';

export interface BackgroundImageAsset {
  id: string;
  name: string;
  objectUrl: string;
}

export interface FrameTelemetry {
  fps: number;
  frameTimeMs: number; // end-to-end render/copy time for the current frame
  latencyMs: number; // alias kept for UI wording; equals frameTimeMs for now
  droppedFrames: number;
}

export interface WorkerInitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface WorkerFrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  frameId: number;
  timestampMs: number;
}

export interface WorkerSetEffectMessage {
  type: 'setEffect';
  effect: VirtualBackgroundEffect;
  blurStrength: number; // 0..30
}

export interface WorkerSetBackgroundImageMessage {
  type: 'setBackgroundImage';
  bitmap: ImageBitmap | null;
}

export type VirtualBackgroundWorkerMessage =
  | WorkerInitMessage
  | WorkerFrameMessage
  | WorkerSetEffectMessage
  | WorkerSetBackgroundImageMessage;

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerFrameRenderedMessage {
  type: 'frameRendered';
  frameId: number;
  latencyMs: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
}

export type VirtualBackgroundWorkerResponse =
  | WorkerReadyMessage
  | WorkerFrameRenderedMessage
  | WorkerErrorMessage;

