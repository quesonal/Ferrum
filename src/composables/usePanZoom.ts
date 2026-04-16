import {ref, type Ref} from 'vue';

interface PanZoomOptions {
  viewportRef: Ref<HTMLElement | null>;
  imgRef: Ref<HTMLImageElement | null>;
}

export function usePanZoom({viewportRef, imgRef}: PanZoomOptions) {
  const scale = ref(1);
  const translate = ref({x: 0, y: 0});
  const isDragging = ref(false);
  const startPos = ref({x: 0, y: 0});
  const minScale = ref(1); // 默认最小缩放为 100%，加载图片后会更新

  // --- 触摸板缩放累积值 ---
  let pinchAccumulate = 0;
  const PINCH_THRESHOLD = 0.5; // 触发缩放的阈值

  const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

  // --- 边界限制计算 ---
  const getConstrainedTranslate = (targetX: number, targetY: number, currentScale: number) => {
    if (!viewportRef.value || !imgRef.value) return {x: 0, y: 0};

    const vpw = viewportRef.value.clientWidth;
    const vph = viewportRef.value.clientHeight;
    const imgW = imgRef.value.naturalWidth * currentScale;
    const imgH = imgRef.value.naturalHeight * currentScale;

    let x = targetX;
    let y = targetY;

    if (imgW > vpw) {
      const limitX = (imgW - vpw) / 2;
      x = clamp(x, -limitX, limitX);
    } else {
      x = 0;
    }

    if (imgH > vph) {
      const limitY = (imgH - vph) / 2;
      y = clamp(y, -limitY, limitY);
    } else {
      y = 0;
    }

    return {x, y};
  };

  // 设置最小缩放值
  const setMinScale = (value: number) => {
    minScale.value = value;
  };

  // --- 核心算法：鼠标滚轮固定步进 ---
  const calcNextScale = (current: number, direction: 'in' | 'out') => {
    const epsilon = 0.001;
    const MAX_SCALE = 5.0; // 最大500%
    const step = 0.1; // 固定10%步进

    if (direction === 'in') {
      if (current >= MAX_SCALE - epsilon) return MAX_SCALE;
      if (current < minScale.value + step - epsilon) return minScale.value + step;
      const next = (Math.floor(current / step + epsilon) + 1) * step;
      return Math.min(next, MAX_SCALE);
    } else {
      if (current <= minScale.value + epsilon) return minScale.value;
      const next = (Math.ceil(current / step - epsilon) - 1) * step;
      return Math.max(minScale.value, next);
    }
  };

  // --- 核心算法：触摸板分段步进 ---
  const calcNextScaleTouchpad = (current: number, direction: 'in' | 'out') => {
    const epsilon = 0.001;
    const MAX_SCALE = 5.0; // 最大500%
    let step = 0.1;

    if (direction === 'in') {
      if (current >= MAX_SCALE - epsilon) return MAX_SCALE;
      if (current < minScale.value + step - epsilon) return minScale.value + step;

      // 触摸板：分段步进
      if (current >= 5.0 - epsilon) {
        step = 0.5;
      } else if (current >= 3.0 - epsilon) {
        step = 0.2;
      } else if (current >= 1.0 - epsilon) {
        step = 0.1;
      } else {
        step = 0.05;
      }

      const next = (Math.floor(current / step + epsilon) + 1) * step;
      return Math.min(next, MAX_SCALE);
    } else {
      if (current <= minScale.value + epsilon) return minScale.value;

      // 触摸板：分段步进
      if (current > 5.0 + epsilon) {
        step = 0.5;
      } else if (current > 3.0 + epsilon) {
        step = 0.2;
      } else if (current > 1.0 + epsilon) {
        step = 0.1;
      } else {
        step = 0.05;
      }

      const next = (Math.ceil(current / step - epsilon) - 1) * step;
      return Math.max(minScale.value, next);
    }
  };

  // --- 执行缩放 ---
  const performZoom = (direction: 'in' | 'out', fixedPoint: { x: number, y: number } | null = null, isTouchpad = false) => {
    const newScale = isTouchpad
      ? calcNextScaleTouchpad(scale.value, direction)
      : calcNextScale(scale.value, direction);

    // 如果数值没变(已达极限)，则不执行后续计算
    if (Math.abs(newScale - scale.value) < 0.001) return;

    let targetTx = translate.value.x;
    let targetTy = translate.value.y;

    if (fixedPoint) {
      const imgX = (fixedPoint.x - translate.value.x) / scale.value;
      const imgY = (fixedPoint.y - translate.value.y) / scale.value;

      targetTx = fixedPoint.x - imgX * newScale;
      targetTy = fixedPoint.y - imgY * newScale;
    }

    const constrained = getConstrainedTranslate(targetTx, targetTy, newScale);

    scale.value = newScale;
    translate.value = constrained;
  };

  // --- 事件监听 ---
  const handleWheel = (e: WheelEvent) => {
    if (!viewportRef.value) return;

    const rect = viewportRef.value.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    // 检测触摸板双指缩放 (Ctrl+滚轮 或 macOS pinch gesture)
    if (e.ctrlKey || e.metaKey) {
      // 使用 deltaX 和 deltaY 的综合位移计算缩放幅度，更线性自然
      const delta = Math.hypot(e.deltaX, e.deltaY);
      // 判断缩放方向：双指分开(放大)时 deltaY 通常为负，双指靠拢(缩小)时为正
      // 但也需要考虑 deltaX 的符号，取综合效果
      const direction = e.deltaY < 0 ? -1 : 1;

      // 累积位移量
      pinchAccumulate += delta * direction;

      // 只有当累积值达到阈值时才执行缩放
      if (Math.abs(pinchAccumulate) >= PINCH_THRESHOLD) {
        const zoomDirection = pinchAccumulate < 0 ? 'in' : 'out';
        performZoom(zoomDirection, {x: mouseX, y: mouseY}, true); // true = 使用触摸板分段步进
        // 重置累积值
        pinchAccumulate = 0;
      }
      return;
    }

    // 普通滚轮缩放：固定步进
    const direction = e.deltaY < 0 ? 'in' : 'out';
    performZoom(direction, {x: mouseX, y: mouseY});
  };

  const startDrag = (e: MouseEvent) => {
    if (e.button !== 0) return;
    isDragging.value = true;
    startPos.value = {
      x: e.clientX - translate.value.x,
      y: e.clientY - translate.value.y
    };
  };

  const onDrag = (e: MouseEvent) => {
    if (!isDragging.value) return;
    const rawX = e.clientX - startPos.value.x;
    const rawY = e.clientY - startPos.value.y;
    translate.value = getConstrainedTranslate(rawX, rawY, scale.value);
  };

  const stopDrag = () => {
    isDragging.value = false;
  };

  const fitToScreen = (targetImg?: HTMLImageElement | null) => {
    // 优先使用传入的 targetImg，否则使用 hook 绑定的 activeImgRef
    const img = targetImg || imgRef.value;
    const viewport = viewportRef.value;
    if (!viewport || !img) return;

    const vpw = viewport.clientWidth;
    const vph = viewport.clientHeight;
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (!imgW || !imgH) return;

    const scaleX = vpw / imgW;
    const scaleY = vph / imgH;
    // 最小缩放：适应窗口且不超过原始分辨率
    const fitScale = Math.min(scaleX, scaleY);
    scale.value = Math.min(fitScale, 1);
    translate.value = {x: 0, y: 0};
  };

  return {
    scale,
    translate,
    minScale,
    setMinScale,
    fitToScreen,
    handleWheel,
    startDrag,
    onDrag,
    stopDrag,
    zoomIn: () => performZoom('in'),
    zoomOut: () => performZoom('out'),
    getConstrainedTranslate: (targetX: number, targetY: number, currentScale?: number) => {
      return getConstrainedTranslate(targetX, targetY, currentScale ?? scale.value);
    }
  };
}