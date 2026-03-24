import { computed, onBeforeUnmount, ref } from 'vue';

export interface UseWebcamStreamOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
  /**
   * Optional minimum frame rate hint for negotiation fallback.
   */
  frameRateMin?: number;
  /**
   * When provided, always request this device.
   * When omitted, uses default device selection.
   */
  deviceId?: string;
}

export interface UseWebcamStreamResult {
  stream: Readonly<MediaStream | null>;
  errorMessage: Readonly<string | null>;
  isStarting: Readonly<boolean>;
  activeDeviceId: Readonly<string | null>;
  availableVideoInputs: Readonly<MediaDeviceInfo[]>;
  start: (options?: Partial<UseWebcamStreamOptions>) => Promise<void>;
  stop: () => void;
}

function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore stop errors on already-stopped tracks.
    }
  }
}

async function enumerateVideoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

function buildConstraints(options: UseWebcamStreamOptions): MediaStreamConstraints {
  const videoConstraints: MediaTrackConstraints = {};
  if (options.facingMode) {
    videoConstraints.facingMode = options.facingMode;
  }
  if (options.width) {
    videoConstraints.width = { ideal: options.width };
  }
  if (options.height) {
    videoConstraints.height = { ideal: options.height };
  }
  if (options.frameRate) {
    if (options.frameRateMin) {
      videoConstraints.frameRate = { ideal: options.frameRate, min: options.frameRateMin };
    } else {
      videoConstraints.frameRate = { ideal: options.frameRate };
    }
  }

  // If deviceId is provided, prefer exact match.
  if (options.deviceId) {
    videoConstraints.deviceId = { exact: options.deviceId };
  }

  const constraints: MediaStreamConstraints = {
    video: videoConstraints,
    audio: false,
  };

  return constraints;
}

function getTrackFrameRate(stream: MediaStream): number | null {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const rate = track.getSettings().frameRate;
  if (!rate || !Number.isFinite(rate)) return null;
  return rate;
}

async function getUserMediaWithAdaptiveFallback(
  baseOptions: UseWebcamStreamOptions,
  minAcceptableFps = 24,
): Promise<MediaStream> {
  const targetFps = baseOptions.frameRate ?? 30;
  const width = baseOptions.width ?? 1280;
  const height = baseOptions.height ?? 720;
  const profiles: Array<{ scale: number; fps: number; minFps: number }> = [
    { scale: 1.0, fps: targetFps, minFps: Math.min(minAcceptableFps, targetFps) },
    { scale: 0.75, fps: targetFps, minFps: Math.min(20, targetFps) },
    { scale: 0.5, fps: targetFps, minFps: Math.min(15, targetFps) },
    { scale: 0.5, fps: Math.min(targetFps, 24), minFps: 10 },
  ];

  let lastError: unknown = null;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]!;
    const attempt: UseWebcamStreamOptions = {
      ...baseOptions,
      width: Math.max(320, Math.round(width * p.scale)),
      height: Math.max(240, Math.round(height * p.scale)),
      frameRate: p.fps,
      frameRateMin: p.minFps,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildConstraints(attempt));
      const actualFps = getTrackFrameRate(stream);
      const isLast = i === profiles.length - 1;
      if (actualFps === null || actualFps >= minAcceptableFps || isLast) {
        return stream;
      }
      stopMediaStream(stream);
    } catch (err: unknown) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error('Unable to acquire webcam stream');
}

export function useWebcamStream(initialOptions?: UseWebcamStreamOptions): UseWebcamStreamResult {
  const stream = ref<MediaStream | null>(null);
  const errorMessage = ref<string | null>(null);
  const isStarting = ref<boolean>(false);
  const activeDeviceId = ref<string | null>(initialOptions?.deviceId ?? null);
  const availableVideoInputs = ref<MediaDeviceInfo[]>([]);

  const stop = () => {
    stopMediaStream(stream.value);
    stream.value = null;
  };

  const start = async (options?: Partial<UseWebcamStreamOptions>) => {
    if (isStarting.value) return;
    isStarting.value = true;
    errorMessage.value = null;

    try {
      stopMediaStream(stream.value);
      stream.value = null;

      // Ensure we have an up-to-date device list.
      try {
        availableVideoInputs.value = await enumerateVideoInputs();
      } catch {
        // Ignore; device enumeration can fail until permission is granted.
      }

      const merged: UseWebcamStreamOptions = {
        facingMode: initialOptions?.facingMode,
        width: initialOptions?.width,
        height: initialOptions?.height,
        frameRate: initialOptions?.frameRate,
        deviceId: initialOptions?.deviceId,
        ...options,
      };

      const nextStream = await getUserMediaWithAdaptiveFallback(merged);
      stream.value = nextStream;

      const videoTrack = nextStream.getVideoTracks()[0];
      if (videoTrack) {
        // Hint browser pipeline for low-latency camera processing.
        try {
          videoTrack.contentHint = 'motion';
        } catch {
          // Ignore unsupported contentHint.
        }
        activeDeviceId.value = videoTrack.getSettings().deviceId ?? null;
      }

      // Refresh available devices now that permission is granted.
      try {
        availableVideoInputs.value = await enumerateVideoInputs();
      } catch {
        // Ignore enumeration failures.
      }
    } catch (err: unknown) {
      errorMessage.value = err instanceof Error ? err.message : 'Failed to start webcam';
      stop();
    } finally {
      isStarting.value = false;
    }
  };

  let deviceChangeTimer: number | null = null;
  const onDeviceChange = () => {
    // Debounce to avoid multiple restarts during rapid device transitions.
    if (deviceChangeTimer) window.clearTimeout(deviceChangeTimer);
    deviceChangeTimer = window.setTimeout(async () => {
      try {
        availableVideoInputs.value = await enumerateVideoInputs();
      } catch {
        // Ignore.
      }

      const current = stream.value;
      const currentTrack = current?.getVideoTracks()[0] ?? null;
      const currentDeviceId = currentTrack ? currentTrack.getSettings().deviceId ?? null : null;

      // If the active device disappeared, restart to keep UI resilient.
      const activeDeviceExists = currentDeviceId
        ? availableVideoInputs.value.some((d) => d.deviceId === currentDeviceId)
        : true;

      if (!activeDeviceExists) {
        await start();
      }
    }, 400);
  };

  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

  onBeforeUnmount(() => {
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    if (deviceChangeTimer) window.clearTimeout(deviceChangeTimer);
    stop();
  });

  return {
    stream: computed(() => stream.value),
    errorMessage: computed(() => errorMessage.value),
    isStarting: computed(() => isStarting.value),
    activeDeviceId: computed(() => activeDeviceId.value),
    availableVideoInputs: computed(() => availableVideoInputs.value),
    start,
    stop,
  };
}

