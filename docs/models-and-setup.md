# MediaPipe Models and Setup

This project uses `@mediapipe/tasks-vision` (v0.10+) for image segmentation.

## Model placement

Place your MediaPipe model files under:

`public/models/`

Example:

`public/models/deeplabv3.tflite`

Then configure the model path in the (next prompt) MediaPipe segmenter code:
- `modelAssetPath: "/models/deeplabv3.tflite"`

## WASM assets

MediaPipe loads wasm via `FilesetResolver.forVisionTasks(wasmUrl)`.
The default in the segmenter module points at the official CDN.

For strict self-hosting:
- download the tasks-vision wasm bundle and serve it locally
- set `wasmUrl` to your local copy in the segmenter options

## Browser requirements

To meet performance requirements:
- Prefer WebGL2 capable browsers
- Use a worker for segmentation to avoid UI thread blocking

