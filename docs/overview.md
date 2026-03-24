# Virtual Background Engine (Dev Step)

This project scaffolds a production-grade virtual background engine for a self-hosted LiveKit webinar platform.

In this dev step, the renderer is wired end-to-end and runs at real-time performance using a WebGL2 “copy/no-effect” path:
- Side-by-side preview (`Original` video element vs `Processed` canvas)
- Real-time FPS counter
- Frame render latency display

AI segmentation (MediaPipe Tasks Vision) and mask-based compositing are intentionally disabled until the next prompt, while the worker/offscreen canvas architecture is already in place for future enablement.

