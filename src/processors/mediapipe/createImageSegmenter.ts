import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
  type VisionTaskRunner,
} from '@mediapipe/tasks-vision';

export interface CreateImageSegmenterOptions {
  /**
   * WASM base URL for MediaPipe.
   * If omitted, we default to the official CDN.
   */
  wasmUrl?: string;
  /**
   * Path (relative to server root) or absolute URL to the model.
   * Example: `/models/deeplabv3.tflite`
   */
  modelAssetPath: string;
  /**
   * If true, returns a category mask (uint8 category indices).
   */
  outputCategoryMask?: boolean;
  /**
   * If true, returns confidence masks (float values).
   */
  outputConfidenceMasks?: boolean;
}

const DEFAULT_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';

export async function createImageSegmenter(
  options: CreateImageSegmenterOptions,
): Promise<{
  segmenter: ImageSegmenter;
  // kept for future flexibility and typing.
  runner: VisionTaskRunner;
}> {
  const wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;

  const vision = await FilesetResolver.forVisionTasks(wasmUrl);

  // MediaPipe tasks-vision uses `runningMode` to decide whether segmentForVideo
  // dispatches async callbacks for video streams.
  const segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: options.modelAssetPath,
    },
    outputCategoryMask: options.outputCategoryMask ?? true,
    outputConfidenceMasks: options.outputConfidenceMasks ?? false,
    runningMode: 'VIDEO',
  });

  // runner is not currently needed by our pipeline, but it gives us a typed hook later.
  const runner = segmenter as unknown as VisionTaskRunner;

  return { segmenter, runner };
}

export function segmentForVideoAsync(
  segmenter: ImageSegmenter,
  video: HTMLVideoElement,
  startTimeMs: number,
): Promise<ImageSegmenterResult> {
  return new Promise<ImageSegmenterResult>((resolve) => {
    segmenter.segmentForVideo(video, startTimeMs, (result) => resolve(result));
  });
}

