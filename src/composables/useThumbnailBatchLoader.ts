import { useLibraryStore } from '../stores/libraryStore';

const BATCH_SIZE = 24;
const MAX_CONCURRENT_BATCHES = 3;

export function useThumbnailBatchLoader() {
  const store = useLibraryStore();
  const queue = new Set<string>();
  let activeRequests = 0;

  function processQueue() {
    if (activeRequests >= MAX_CONCURRENT_BATCHES || queue.size === 0) return;

    const batch: string[] = [];
    const iterator = queue.values();
    for (let index = 0; index < BATCH_SIZE; index++) {
      const { value, done } = iterator.next();
      if (done) break;
      batch.push(value);
      queue.delete(value);
    }
    if (batch.length === 0) return;

    activeRequests++;
    store.getThumbnailsBatch(batch).finally(() => {
      activeRequests--;
      processQueue();
    });
  }

  function requestPreload(ids: string[]) {
    queue.clear();
    ids.forEach(id => queue.add(id));
    processQueue();
  }

  return { requestPreload };
}
