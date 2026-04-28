<!-- components/Scrollbar.vue -->
<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  maxSpeed?: number; // 操纵杆推到底时的最高限速 (px/帧)，默认 150 (相当于 9000px/秒)
}>();

const emit = defineEmits<{
  (e: 'scroll-step', velocity: number): void; // 派发每帧应该滚动的像素
  (e: 'jump-top'): void;
  (e: 'jump-bottom'): void;
}>();

const trackRef = ref<HTMLElement | null>(null);
const thumbRef = ref<HTMLElement | null>(null);

const isDragging = ref(false);
const thumbOffset = ref(0);   // 滑块偏离中心的像素
let startY = 0;
let maxTravel = 100;          // 滑块单向最大滑动距离

let currentVelocity = 0;
let rafId: number | null = null;

const MAX_SPEED = props.maxSpeed || 150;

function startDrag(e: PointerEvent) {
  isDragging.value = true;
  startY = e.clientY;

  // 动态计算滑块可以上下移动的最大极限 (轨道高度一半 减去 滑块高度一半)
  if (trackRef.value && thumbRef.value) {
    maxTravel = (trackRef.value.clientHeight - thumbRef.value.clientHeight) / 2;
  }

  // 捕获全局鼠标事件，防止拖出浏览器外断触
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'ns-resize'; // 强制改变全局鼠标指针为上下拖拽

  if (!rafId) loop();
}

function onDrag(e: PointerEvent) {
  if (!isDragging.value) return;

  // 1. 计算鼠标偏离中心点（起始点）的物理像素
  let deltaY = e.clientY - startY;

  // 2. 限制滑块不能飞出轨道
  if (deltaY > maxTravel) deltaY = maxTravel;
  if (deltaY < -maxTravel) deltaY = -maxTravel;

  thumbOffset.value = deltaY;

  // 3. ✨ 核心手感算法：二次方速度曲线 (Quadratic Curve)
  // 如果用线性比例，微调会很难控制。二次方曲线可以实现：中心区域推得很慢很准，推到底极快！
  const ratio = deltaY / maxTravel; // -1.0 到 1.0
  const sign = Math.sign(ratio);    // 方向：1向下，-1向上
  const curve = Math.pow(Math.abs(ratio), 2); // 取绝对值的平方

  currentVelocity = sign * curve * MAX_SPEED;
}

function endDrag() {
  isDragging.value = false;
  thumbOffset.value = 0; // 松手，数据归零，CSS transition 负责弹簧视觉归位
  currentVelocity = 0;

  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', endDrag);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

// 动画引擎：只要推着不放，或者有速度，就一直向父组件派发位移指令
function loop() {
  if (isDragging.value && currentVelocity !== 0) {
    emit('scroll-step', currentVelocity);
  }

  if (isDragging.value) {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = null;
  }
}
</script>

<template>
  <div class="picasa-scrollbar-container">

    <!-- 顶部直达按钮 -->
    <button class="nav-btn top-btn" @click="emit('jump-top')" title="回到顶部">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
    </button>

    <!-- 操纵杆轨道 -->
    <div class="joystick-track" ref="trackRef">
      <div
          class="joystick-thumb"
          ref="thumbRef"
          :style="{
          transform: `translateY(${thumbOffset}px)`,
          transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }"
          @pointerdown.stop="startDrag"
      >
        <!-- 操纵杆防滑纹理 -->
        <div class="grip-line"></div>
        <div class="grip-line"></div>
        <div class="grip-line"></div>
      </div>
    </div>

    <!-- 底部直达按钮 -->
    <button class="nav-btn bottom-btn" @click="emit('jump-bottom')" title="到达底部">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
    </button>

  </div>
</template>

<style scoped>
.picasa-scrollbar-container {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 18px; /* 轨道宽度 */
  background: var(--ui-bg);
  border-left: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  z-index: 50;
  user-select: none;
  box-sizing: border-box;
}

.nav-btn {
  width: 100%;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-dim, #888);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}
.nav-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.nav-btn svg {
  width: 12px;
  height: 12px;
  display: block;
  stroke: currentColor;
  flex-shrink: 0;
}

.joystick-track {
  flex: 1; /* 撑满中间剩余空间 */
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center; /* 【魔法属性】：自动将滑块按在绝对中间 */
  background: rgba(0, 0, 0, 0.2);
  box-shadow: inset 0 0 4px rgba(0,0,0,0.5);
  margin: 0;
  width: 100%;
  overflow: hidden;
}

.joystick-thumb {
  width: 12px;
  height: 48px;
  background: linear-gradient(180deg, #5a5a5a 0%, #444 100%);
  border: 1px solid #222;
  border-radius: 4px;
  cursor: ns-resize;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 2px 5px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.2);
  will-change: transform;
}
.joystick-thumb:hover { background: linear-gradient(180deg, #666 0%, #555 100%); }
.joystick-thumb:active { background: #666; cursor: grabbing; }

/* 物理操纵杆的三条凹凸防滑线 */
.grip-line {
  width: 6px; height: 2px;
  background: #2a2a2a;
  border-bottom: 1px solid rgba(255,255,255,0.2);
  border-radius: 1px;
}
</style>