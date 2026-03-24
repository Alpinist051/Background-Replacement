export interface FpsSample {
  fps: number;
  frameCount: number;
}

/**
 * Sliding-window FPS estimator.
 * Keeps timestamps (ms) for the last `windowMs` and computes FPS from oldest->newest.
 */
export class FpsCounter {
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(windowMs: number = 1000) {
    this.windowMs = Math.max(100, windowMs);
  }

  tick(nowMs: number): FpsSample {
    const cutoff = nowMs - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    this.timestamps.push(nowMs);

    const frameCount = this.timestamps.length;
    if (frameCount < 2) {
      return { fps: 0, frameCount };
    }

    const oldest = this.timestamps[0]!;
    const newest = this.timestamps[frameCount - 1]!;
    const dt = newest - oldest;
    if (dt <= 0) return { fps: 0, frameCount };

    const fps = ((frameCount - 1) / dt) * 1000;
    return { fps, frameCount };
  }

  reset(): void {
    this.timestamps = [];
  }
}

