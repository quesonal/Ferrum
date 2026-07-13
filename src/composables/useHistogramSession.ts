import { ref, watch } from 'vue';
import { useImageStore } from '../stores/imageStore';
import type { HistogramData, ExifData, HistogramSource } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { useConfigStore } from '../stores/configStore';
import type { MaybeRefOrGetter } from 'vue';
import { toValue } from 'vue';
import { useRaceCounter } from '../utils/useRaceCounter';

/**
 * Histogram & EXIF sidebar data source（父组件计算，传 props 给 Histogram）。
 * 触发条件：currentImageId / currentPath / isFastNavigating / show_histogram 任一变化。
 * 关 histogram 或在长按翻页期 → 不计算（histogram 已显示的内容保留，松手后再刷一次）。
 * 走 imageStore.loadHistogram(source) 拿数据，race condition 用 raceCounter 守门。
 */
export function useHistogramSession(isFastNavigating: MaybeRefOrGetter<boolean>) {
  const imageStore = useImageStore();
  const libraryStore = useLibraryStore();
  const configStore = useConfigStore();

  const histogramData = ref<HistogramData | null>(null);
  const exifData = ref<ExifData>({});
  const isHistogramLoading = ref(false);
  const version = useRaceCounter('histogram-session');

  watch(
    [
      () => libraryStore.currentImageId,
      () => imageStore.currentPath,
      () => toValue(isFastNavigating),
      () => configStore.config.show_histogram,
    ],
    async ([id, path, fast, show]) => {
      const session = version.begin();

      if (!show) {
        histogramData.value = null;
        exifData.value = {};
        isHistogramLoading.value = false;
        return;
      }

      if (fast || (!id && !path)) {
        // 长按期间不重算（避免 25fps × fetch + compute 的主线程开销）
        // currentPath/currentImageId 已变，但 isHistogramLoading 保持现有状态
        return;
      }

      isHistogramLoading.value = true;
      const source: HistogramSource = {
        kind: id ? 'library' : 'filesystem',
        id: id ?? undefined,
        path: path ?? undefined,
      };

      try {
        const result = await imageStore.loadHistogram(source);
        if (!version.isLatest(session)) return; // 已被更新的 watch 抢断
        if (result) {
          histogramData.value = result.histogram;
          exifData.value = result.exif;
        }
      } finally {
        if (version.isLatest(session)) {
          isHistogramLoading.value = false;
        }
      }
    },
    { immediate: true }
  );

  return { histogramData, exifData, isHistogramLoading };
}
