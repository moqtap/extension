/**
 * Composable for auto-scrolling a container to the bottom.
 * Respects manual scroll — if the user scrolls up, auto-scroll pauses.
 * Resumes when the user scrolls back to the bottom.
 */

import { ref, onMounted, onUnmounted, type Ref } from 'vue';

const SCROLL_THRESHOLD = 30; // px from bottom to consider "at bottom"

export function useAutoScroll(containerRef: Ref<HTMLElement | null>) {
  const isAtBottom = ref(true);

  function onScroll() {
    const el = containerRef.value;
    if (!el) return;
    isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }

  function scrollToBottom() {
    const el = containerRef.value;
    if (!el || !isAtBottom.value) return;
    el.scrollTop = el.scrollHeight;
  }

  let observer: MutationObserver | null = null;

  onMounted(() => {
    const el = containerRef.value;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });

    // Auto-scroll when new content is added
    observer = new MutationObserver(() => {
      if (isAtBottom.value) {
        requestAnimationFrame(() => scrollToBottom());
      }
    });
    observer.observe(el, { childList: true, subtree: true });
  });

  onUnmounted(() => {
    const el = containerRef.value;
    if (el) el.removeEventListener('scroll', onScroll);
    observer?.disconnect();
  });

  return { isAtBottom, scrollToBottom };
}
