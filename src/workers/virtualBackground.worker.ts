import type {
  VirtualBackgroundEffect,
  VirtualBackgroundWorkerMessage,
  WorkerErrorMessage,
} from '@/types/video-processing';
import { VirtualBackgroundRenderer } from '@/processors/virtual-background/VirtualBackgroundRenderer';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let renderer: VirtualBackgroundRenderer | null = null;
let effect: VirtualBackgroundEffect = 'none';
let blurStrength = 0;
let backgroundBitmap: ImageBitmap | null = null;

function postError(message: string, stack?: string): void {
  const payload: WorkerErrorMessage = { type: 'error', message, stack };
  ctx.postMessage(payload);
}

ctx.onmessage = (e: MessageEvent<VirtualBackgroundWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      renderer = new VirtualBackgroundRenderer(msg.canvas, {
        width: msg.width,
        height: msg.height,
        devicePixelRatio: msg.devicePixelRatio,
      });
      // No-op until AI processing is enabled in later prompts.
      return;
    }

    if (!renderer) {
      postError('Worker renderer not initialized');
      return;
    }

    if (msg.type === 'setEffect') {
      effect = msg.effect;
      blurStrength = msg.blurStrength;
      return;
    }

    if (msg.type === 'setBackgroundImage') {
      if (backgroundBitmap) {
        try {
          backgroundBitmap.close();
        } catch {
          // Ignore close errors.
        }
        backgroundBitmap = null;
      }
      backgroundBitmap = msg.bitmap;
      return;
    }

    if (msg.type === 'frame') {
      // For now we perform a real copy (effect 'none' semantics).
      // When AI processing is introduced, this will become mask + compositing.
      renderer.render(msg.bitmap, { flipY: 1 });
      msg.bitmap.close();
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Worker error';
    postError(message, err instanceof Error ? err.stack : undefined);
  }
};

