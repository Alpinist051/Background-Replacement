import type {
  BackgroundImageAsset,
  VirtualBackgroundEffect,
} from '@/types/video-processing';
import type { VirtualBackgroundRenderer } from './VirtualBackgroundRenderer';

export interface VirtualBackgroundPipelineOptions {
  renderer: VirtualBackgroundRenderer;
  effect: VirtualBackgroundEffect;
  blurStrength: number; // 0..30
  backgroundImage: BackgroundImageAsset | null;
}

/**
 * Production pipeline entrypoint (currently implements real copy/no-effect).
 * The full segmentation + mask compositing path will be introduced in the next prompt.
 */
export class VirtualBackgroundPipeline {
  private effect: VirtualBackgroundEffect;
  private blurStrength: number;
  private backgroundImage: BackgroundImageAsset | null;
  private readonly renderer: VirtualBackgroundRenderer;

  constructor(options: VirtualBackgroundPipelineOptions) {
    this.renderer = options.renderer;
    this.effect = options.effect;
    this.blurStrength = options.blurStrength;
    this.backgroundImage = options.backgroundImage;
  }

  setEffect(effect: VirtualBackgroundEffect): void {
    this.effect = effect;
  }

  setBlurStrength(blurStrength: number): void {
    this.blurStrength = Math.max(0, Math.min(30, blurStrength));
  }

  setBackgroundImage(backgroundImage: BackgroundImageAsset | null): void {
    this.backgroundImage = backgroundImage;
  }

  /**
   * Render a single frame into the output canvas.
   * When effect is not `none`, this currently still copies input to output.
   */
  renderFrame(input: HTMLVideoElement | ImageBitmap): void {
    // No AI processing yet by design for this dev step.
    this.renderer.render(input, { flipY: 1 });
  }
}

