import { computed, onBeforeUnmount, ref } from 'vue';

export interface UseWebcamStreamOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
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
    videoConstraints.frameRate = { ideal: options.frameRate };
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

      const constraints = buildConstraints(merged);

      const nextStream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.value = nextStream;

      const videoTrack = nextStream.getVideoTracks()[0];
      if (videoTrack) {
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

