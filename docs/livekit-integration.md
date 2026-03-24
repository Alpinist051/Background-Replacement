# LiveKit Integration Guide

Goal: feed processed video frames into LiveKit as a custom track processor.

## High-level architecture

1. Create a `VirtualBackgroundProcessor` on the subscriber side (or per participant) in your webinar client.
2. Render original frames to an offscreen pipeline (worker + offscreen canvas).
3. Export the processed track back into LiveKit using `@livekit/track-processors`.

## Where this repo fits

This scaffold includes:
- Worker/offscreen canvas scaffolding (`src/workers/virtualBackground.worker.ts`)
- A WebGL renderer that can run on `OffscreenCanvas` (`src/processors/virtual-background/VirtualBackgroundRenderer.ts`)

When you enable the AI path, you will:
- run MediaPipe segmentation in the worker
- composite foreground/background via WebGL mask compositing shaders
- push processed frames downstream to LiveKit’s processor pipeline

## Notes

The exact LiveKit track processor wiring depends on whether you process:
- a camera publishing track
- a subscribed participant track

In both cases, keep processing off the main thread and implement frame dropping to meet your FPS target.

