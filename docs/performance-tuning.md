# Performance Tuning

Target: `>= 25 FPS` on mid-range laptops.

## What this dev step does (and why)

The current implementation renders a real-time copy path with WebGL2:
- Avoids CPU-heavy `canvas 2D` filters.
- Uses a single fullscreen shader to avoid flicker and halos from multi-pass postprocessing.
- Cancels the render loop when the browser tab is hidden.

## Rendering loop strategy

Use a single `requestAnimationFrame` loop and measure per-frame render time.

Recommended production changes when enabling blur/background effects:
- Move MediaPipe segmentation off the main thread using a Web Worker.
- Consider throttling segmentation to e.g. `15-30 FPS` and reuse the latest mask for intermediate frames.
- Avoid uploading full-resolution video frames to WebGL more than necessary:
  - Render at a fixed internal resolution (e.g. clamp to 720p).
  - Scale via shader uniforms rather than resizing the canvas every frame.

## WebGL settings

For stability (and to reduce jitter):
- Prefer WebGL2 and a deterministic shader pipeline.
- Set textures to `CLAMP_TO_EDGE` and `LINEAR` filtering.
- Reuse GL objects (programs, VAOs, textures) and only update the video texture per frame.

## Backpressure and dropped frames

When enabling AI processing:
- If the worker is behind, drop stale frames instead of queueing unbounded work.
- Track `droppedFrames` and display it for debugging.

## Known UI blocking behavior to avoid

MediaPipe’s `segment()` / `segmentForVideo()` can block the UI thread if executed on the main thread.
In production, always run the segmentation in a worker to keep the UI responsive.

