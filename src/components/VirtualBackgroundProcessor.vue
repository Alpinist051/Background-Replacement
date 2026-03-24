<template>
  <div class="px-4 py-6">
    <div class="mx-auto max-w-6xl">
      <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 class="text-2xl font-semibold">Virtual Background Studio</h1>
          <p class="mt-1 text-slate-300">
            A friendly preview bench with live performance cues so you can focus on experimenting with confidence.
          </p>
        </div>

        <div class="flex items-center gap-3">
          <div class="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-400">Live FPS</div>
            <div class="text-lg font-semibold leading-none">{{ telemetry.fps.toFixed(1) }}</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-400">Render latency</div>
            <div class="text-lg font-semibold leading-none">{{ telemetry.frameTimeMs.toFixed(2) }} ms</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-400">UI FPS</div>
            <div class="text-lg font-semibold leading-none">{{ uiFps.toFixed(0) }}</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-400">Heap</div>
            <div class="text-lg font-semibold leading-none">{{ heapUsedMb.toFixed(0) }} MB</div>
          </div>
        </div>
      </div>

      <div class="grid gap-5 lg:grid-cols-[420px_1fr]">
        <Card class="bg-slate-900/40 border-slate-800">
          <template #title>
            Control center
          </template>
          <template #content>
            <div class="flex flex-col gap-5">
              <div>
                <div class="mb-2 text-sm font-medium text-slate-200">Background effect</div>
                <SelectButton
                  v-model="effect"
                  :options="effectOptions"
                  optionLabel="label"
                  optionValue="value"
                  class="w-full"
                />
                <p class="mt-2 text-xs text-amber-300">
                  Thank you for stopping by — the heavy lifting executes in a dedicated Web Worker with OffscreenCanvas + MediaPipe, so your UI stays smooth while testing looks.
                </p>
              </div>

              <div>
                <div class="mb-2 flex items-center justify-between">
                  <div class="text-sm font-medium text-slate-200">Blur strength</div>
                  <div class="text-sm font-semibold text-slate-100">{{ blurStrength }}</div>
                </div>
                <Slider
                  v-model="blurStrength"
                  :min="0"
                  :max="30"
                  :step="1"
                  class="w-full"
                  :disabled="effect !== 'blur'"
                />
              </div>

              <div>
                <div class="mb-2 text-sm font-medium text-slate-200">Background gallery</div>
                <div class="flex flex-col gap-3">
                  <input
                    ref="fileInputRef"
                    type="file"
                    accept="image/*"
                    multiple
                    class="hidden"
                    @change="onFilesSelected"
                  />
                  <Button
                    label="Add backgrounds"
                    icon="pi pi-image"
                    class="w-fit"
                    @click="fileInputRef?.click()"
                  />

                  <p v-if="backgroundImages.length === 0" class="text-xs text-slate-400">
                    Upload one or more images to build the gallery (used for the `image` effect). Drag-and-drop works as well — we appreciate you bringing your own scenery!
                  </p>

                  <div v-if="backgroundImages.length > 0" class="grid grid-cols-3 gap-3">
                    <button
                      v-for="img in backgroundImages"
                      :key="img.id"
                      type="button"
                      class="relative rounded-lg border border-slate-800 overflow-hidden bg-slate-950"
                      :class="img.id === selectedBackgroundImageId ? 'ring-2 ring-sky-400' : 'hover:border-slate-600'"
                      @click="selectedBackgroundImageId = img.id"
                      :disabled="effect !== 'image'"
                      :aria-disabled="effect !== 'image'"
                      :title="effect !== 'image' ? 'Select image effect to use background gallery' : 'Select background image'"
                    >
                      <img
                        class="h-20 w-full object-cover"
                        :src="img.objectUrl"
                        :alt="img.name"
                      />
                      <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-1">
                        <div class="truncate text-[10px] font-medium text-slate-100">{{ img.name }}</div>
                      </div>
                    </button>
                  </div>

                  <div v-if="effect === 'image'" class="mt-1 text-xs text-slate-300">
                    Currently active: <span class="font-semibold text-slate-100">{{ selectedBackgroundName }}</span>
                  </div>
                </div>
              </div>

              <div>
                <div class="mb-2 text-sm font-medium text-slate-200">Webcam</div>
                <div v-if="webcamError" class="rounded border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                  {{ webcamError }}
                </div>
                <div v-else-if="engineError" class="rounded border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                  {{ engineError }}
                </div>
                <div v-else class="text-xs text-slate-400">
                  Auto-restart when the active camera changes. Rendering pauses while the tab is hidden so we only work when you're ready—we're grateful for your patience.
                </div>
              </div>
            </div>
          </template>
        </Card>

        <div class="flex flex-col gap-5">
          <Card class="bg-slate-900/40 border-slate-800">
            <template #title>
              Preview
            </template>
            <template #content>
              <div class="grid gap-4 md:grid-cols-2">
                <div class="rounded-xl border border-slate-800 overflow-hidden bg-slate-950/40">
                  <div class="px-3 py-2 border-b border-slate-800 text-sm font-medium text-slate-200">
                    Original
                  </div>
                  <div class="relative">
                    <video
                      ref="originalVideoRef"
                      class="w-full bg-black object-contain"
                      autoplay
                      playsinline
                      muted
                      :style="videoAspectStyle"
                    />
                    <div v-if="!isVideoReady" class="absolute inset-0 flex items-center justify-center p-4">
                      <div class="rounded border border-slate-700 bg-slate-900/60 p-3 text-center text-xs text-slate-300">
                        Hang tight — warming up your webcam.
                      </div>
                    </div>
                  </div>
                </div>

                <div class="rounded-xl border border-slate-800 overflow-hidden bg-slate-950/40">
                  <div class="px-3 py-2 border-b border-slate-800 text-sm font-medium text-slate-200">
                    Processed
                  </div>
                  <div class="relative">
                    <canvas
                      :key="processedCanvasRenderKey"
                      ref="processedCanvasRef"
                      class="w-full bg-black object-contain"
                      :style="videoAspectStyle"
                    />
                    <div v-if="!isProcessedReady" class="absolute inset-0 flex items-center justify-center p-4">
                      <div class="rounded border border-slate-700 bg-slate-900/60 p-3 text-center text-xs text-slate-300">
                        Processing as soon as the first frames arrive — thank you for waiting!
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </Card>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Slider from 'primevue/slider';
import SelectButton from 'primevue/selectbutton';
import type { BackgroundImageAsset, VirtualBackgroundEffect } from '@/types/video-processing';
import { useWebcamStream } from '@/composables/useWebcamStream';
import { usePageVisibility } from '@/composables/usePageVisibility';
import { FpsCounter } from '@/utils/fps-counter';
import { VideoProcessorEngine } from '@/processors/VideoProcessorEngine';

const effectOptions: Array<{ label: string; value: VirtualBackgroundEffect }> = [
  { label: 'Blur', value: 'blur' },
  { label: 'Image', value: 'image' },
  { label: 'None', value: 'none' },
];

const effect = ref<VirtualBackgroundEffect>('none');
const blurStrength = ref<number>(10);

const selectedBackgroundImageId = ref<string | null>(null);
const backgroundImages = ref<BackgroundImageAsset[]>([]);

const fileInputRef = ref<HTMLInputElement | null>(null);

function createAssetFromFile(file: File): BackgroundImageAsset {
  const objectUrl = URL.createObjectURL(file);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    objectUrl,
  };
}

async function onFilesSelected(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement | null;
  const files = input?.files ? Array.from(input.files) : [];
  if (files.length === 0) return;

  const assets = files.filter((f) => f.type.startsWith('image/')).map(createAssetFromFile);
  if (assets.length === 0) return;

  backgroundImages.value = [...backgroundImages.value, ...assets];
  if (!selectedBackgroundImageId.value) selectedBackgroundImageId.value = assets[0]!.id;

  // Allow selecting the same file again later.
  if (input) input.value = '';
}

const selectedBackgroundName = computed(() => {
  const id = selectedBackgroundImageId.value;
  const asset = id ? backgroundImages.value.find((i) => i.id === id) : null;
  return asset?.name ?? 'None';
});

const getSelectedBackgroundAsset = (): BackgroundImageAsset | null => {
  const id = selectedBackgroundImageId.value;
  if (!id) return null;
  return backgroundImages.value.find((i) => i.id === id) ?? null;
};

const originalVideoRef = ref<HTMLVideoElement | null>(null);
const processedCanvasRef = ref<HTMLCanvasElement | null>(null);
const processedCanvasRenderKey = ref<number>(0);

const webcam = useWebcamStream({
  facingMode: 'user',
  width: 1280,
  height: 720,
  frameRate: 30,
});

const { isHidden } = usePageVisibility();

const webcamError = computed(() => webcam.errorMessage.value);

const isVideoReady = ref<boolean>(false);
const isProcessedReady = ref<boolean>(false);
const videoAspect = ref<number>(16 / 9);

const videoAspectStyle = computed(() => {
  const ratio = Number.isFinite(videoAspect.value) && videoAspect.value > 0 ? videoAspect.value : 16 / 9;
  return { aspectRatio: `${ratio}` } as const;
});

const telemetry = reactive({
  fps: 0,
  frameTimeMs: 0,
  droppedFrames: 0,
});

const uiFps = ref<number>(0);
const heapUsedMb = ref<number>(0);

const engineError = ref<string | null>(null);

const processingEngine = ref<VideoProcessorEngine | null>(null);
let unsubscribeTelemetry: (() => void) | null = null;
let unsubscribeError: (() => void) | null = null;
let engineStarting = false;
let engineRestartTimeoutId: number | null = null;
let engineRestartAttempts = 0;

function updateVideoAspectFromMeta(): void {
  const video = originalVideoRef.value;
  if (!video) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw > 0 && vh > 0) {
    videoAspect.value = vw / vh;
  }
}

async function attachStreamToVideo(): Promise<void> {
  const video = originalVideoRef.value;
  const stream = webcam.stream.value;
  if (!video || !stream) return;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  try {
    await video.play();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to start video playback';
    // eslint-disable-next-line no-console
    console.warn(msg);
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handler = () => resolve();
    video.addEventListener('loadedmetadata', handler, { passive: true, once: true });
  });
}

const uiFpsCounter = new FpsCounter(1000);
let uiRafId: number | null = null;
function startUiFpsMonitor(): void {
  if (uiRafId !== null) return;
  const tick = (now: number) => {
    const sample = uiFpsCounter.tick(now);
    uiFps.value = sample.fps;
    uiRafId = window.requestAnimationFrame(tick);
  };
  uiRafId = window.requestAnimationFrame(tick);
}

let memoryTimerId: number | null = null;
type PerformanceMemory = {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
};
function startMemoryMonitor(): void {
  if (memoryTimerId !== null) return;
  const read = () => {
    const p = performance as unknown as { memory?: PerformanceMemory };
    const mem = p.memory;
    if (!mem) return;
    heapUsedMb.value = mem.usedJSHeapSize / 1024 / 1024;
  };

  read();
  memoryTimerId = window.setInterval(read, 1000);
}

function stopUiMonitors(): void {
  if (uiRafId !== null) {
    window.cancelAnimationFrame(uiRafId);
    uiRafId = null;
  }
  if (memoryTimerId !== null) {
    window.clearInterval(memoryTimerId);
    memoryTimerId = null;
  }
}

async function stopEngine(): Promise<void> {
  unsubscribeTelemetry?.();
  unsubscribeTelemetry = null;
  unsubscribeError?.();
  unsubscribeError = null;

  if (engineRestartTimeoutId !== null) {
    window.clearTimeout(engineRestartTimeoutId);
    engineRestartTimeoutId = null;
  }
  engineRestartAttempts = 0;

  processingEngine.value?.stop();
  processingEngine.value = null;
}

async function startEngine(): Promise<void> {
  const video = originalVideoRef.value;
  if (!video) return;

  if (engineStarting) return;
  engineStarting = true;

  engineError.value = null;
  isProcessedReady.value = false;
  telemetry.fps = 0;
  telemetry.frameTimeMs = 0;

  try {
    await stopEngine();
    // OffscreenCanvas transfer is one-way. Re-mount a fresh canvas before every start.
    processedCanvasRenderKey.value += 1;
    await nextTick();
    const canvas = processedCanvasRef.value;
    if (!canvas) return;

    const selectedAsset = effect.value === 'image' ? getSelectedBackgroundAsset() : null;
    const engine = new VideoProcessorEngine({
      effect: effect.value,
      blurStrength: blurStrength.value,
      backgroundImage: selectedAsset,
    });

    unsubscribeTelemetry = engine.onTelemetry((t) => {
      telemetry.fps = t.fps;
      telemetry.frameTimeMs = t.latencyMs;
      if (!isProcessedReady.value && t.fps > 0) {
        isProcessedReady.value = true;
        engineRestartAttempts = 0;
        if (engineRestartTimeoutId !== null) {
          window.clearTimeout(engineRestartTimeoutId);
          engineRestartTimeoutId = null;
        }
      }
    });

    unsubscribeError = engine.onError((message) => {
      engineError.value = message;
    });

    await engine.start(video, canvas);
    processingEngine.value = engine;
  } finally {
    engineStarting = false;
  }
}

watch(
  engineError,
  (err) => {
    if (!err) return;
    if (!isVideoReady.value || isHidden.value) return;

    if (engineRestartTimeoutId !== null) {
      window.clearTimeout(engineRestartTimeoutId);
      engineRestartTimeoutId = null;
    }

    engineRestartAttempts += 1;
    if (engineRestartAttempts > 5) return;

    const backoffMs = Math.min(2000, 200 * engineRestartAttempts);
    engineRestartTimeoutId = window.setTimeout(() => {
      if (!isHidden.value) void startEngine();
    }, backoffMs);
  },
  { flush: 'post' },
);

watch(
  effect,
  (next) => {
    if (!processingEngine.value) return;
    processingEngine.value.setEffect(next, blurStrength.value);
    if (next === 'image') {
      processingEngine.value.setBackgroundImage(getSelectedBackgroundAsset());
    } else {
      processingEngine.value.setBackgroundImage(null);
    }
  },
  { immediate: false },
);

watch(
  blurStrength,
  (next) => {
    if (!processingEngine.value) return;
    processingEngine.value.setEffect(effect.value, next);
  },
  { immediate: false },
);

watch(
  () => [selectedBackgroundImageId.value, effect.value] as const,
  ([id, eff]) => {
    const engine = processingEngine.value;
    if (!engine) return;
    if (eff !== 'image') return;
    if (!id) {
      engine.setBackgroundImage(null);
      return;
    }
    const asset = backgroundImages.value.find((i) => i.id === id) ?? null;
    engine.setBackgroundImage(asset);
  },
  { immediate: false },
);

onMounted(async () => {
  await webcam.start();
  await nextTick();

  const video = originalVideoRef.value;
  if (!video) return;

  await attachStreamToVideo();
  await waitForVideoMetadata(video);
  updateVideoAspectFromMeta();
  isVideoReady.value = true;

  startUiFpsMonitor();
  startMemoryMonitor();

  await startEngine();

  video.addEventListener('ended', () => {
    isVideoReady.value = false;
    isProcessedReady.value = false;
    void stopEngine();
  });

  watch(
    () => webcam.stream.value,
    async (s) => {
      if (!s) {
        isVideoReady.value = false;
        isProcessedReady.value = false;
        await stopEngine();
        return;
      }

      await attachStreamToVideo();
      if (!originalVideoRef.value) return;

      await waitForVideoMetadata(originalVideoRef.value);
      updateVideoAspectFromMeta();
      isVideoReady.value = true;
      isProcessedReady.value = false;
      await startEngine();
    },
    { immediate: false },
  );
});

watch(
  () => isHidden.value,
  async (hidden) => {
    if (hidden) {
      isProcessedReady.value = false;
      await stopEngine();
      return;
    }
    if (isVideoReady.value) {
      await startEngine();
    }
  },
);

onBeforeUnmount(async () => {
  await stopEngine();
  stopUiMonitors();
  for (const img of backgroundImages.value) {
    try {
      URL.revokeObjectURL(img.objectUrl);
    } catch {
      // Ignore.
    }
  }
  backgroundImages.value = [];
  webcam.stop();
});
</script>

