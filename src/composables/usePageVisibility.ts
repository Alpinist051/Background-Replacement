import { onBeforeUnmount, ref } from 'vue';

export function usePageVisibility() {
  const isHidden = ref<boolean>(document.visibilityState === 'hidden');

  const onVisibilityChange = () => {
    isHidden.value = document.visibilityState === 'hidden';
  };

  document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return { isHidden };
}

