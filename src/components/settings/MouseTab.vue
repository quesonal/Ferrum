<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { MouseAction, useConfigStore } from '../../stores/configStore';

const configStore = useConfigStore();
const { config } = storeToRefs(configStore);

type MouseConfigKey = 'mouse_left' | 'mouse_right' | 'mouse_middle' | 'mouse_xbutton1' | 'mouse_xbutton2' | 'mouse_wheel_up' | 'mouse_wheel_down';

const mouseButtonKeys: { key: MouseConfigKey; labelKey: string }[] = [
  { key: 'mouse_left', labelKey: 'settings.mouse.leftClick' },
  { key: 'mouse_right', labelKey: 'settings.mouse.rightClick' },
  { key: 'mouse_middle', labelKey: 'settings.mouse.middleClick' },
  { key: 'mouse_xbutton1', labelKey: 'settings.mouse.sideButton1' },
  { key: 'mouse_xbutton2', labelKey: 'settings.mouse.sideButton2' },
];

const mouseWheelKeys: { key: MouseConfigKey; labelKey: string }[] = [
  { key: 'mouse_wheel_up', labelKey: 'settings.mouse.wheelUp' },
  { key: 'mouse_wheel_down', labelKey: 'settings.mouse.wheelDown' },
];

const actionKeys: { labelKey: string; value: MouseAction }[] = [
  { labelKey: 'settings.actions.none', value: MouseAction.None },
  { labelKey: 'settings.actions.fullScreen', value: MouseAction.FullScreen },
  { labelKey: 'settings.actions.maximize', value: MouseAction.Maximize },
  { labelKey: 'settings.actions.minimize', value: MouseAction.Minimize },
  { labelKey: 'settings.actions.exit', value: MouseAction.Exit },
  { labelKey: 'settings.actions.openFile', value: MouseAction.OpenFile },
  { labelKey: 'settings.actions.openFolder', value: MouseAction.OpenFolder },
  { labelKey: 'settings.actions.nextImage', value: MouseAction.NextImage },
  { labelKey: 'settings.actions.prevImage', value: MouseAction.PrevImage },
  { labelKey: 'settings.actions.firstImage', value: MouseAction.FirstImage },
  { labelKey: 'settings.actions.lastImage', value: MouseAction.LastImage },
  { labelKey: 'settings.actions.forward10', value: MouseAction.Forward10 },
  { labelKey: 'settings.actions.backward10', value: MouseAction.Backward10 },
  { labelKey: 'settings.actions.zoomIn', value: MouseAction.ZoomIn },
  { labelKey: 'settings.actions.zoomOut', value: MouseAction.ZoomOut },
  { labelKey: 'settings.actions.zoom', value: MouseAction.Zoom },
  { labelKey: 'settings.actions.showExif', value: MouseAction.ShowExif },
  { labelKey: 'settings.actions.fitWindow', value: MouseAction.FitWindow },
];
</script>

<template>
  <div class="flex flex-col gap-3">
    <h3 class="text-xs font-bold text-ui-dim uppercase mb-2">{{ $t('settings.mouse.buttons') }}</h3>
    <div v-for="item in mouseButtonKeys" :key="item.key" class="flex items-center justify-between">
      <span class="text-sm">{{ $t(item.labelKey) }}</span>
      <select v-model="config[item.key]" class="bg-ui-hover text-ui-text border border-ui-border rounded px-2 py-1 text-sm w-40 outline-none">
        <option v-for="opt in actionKeys" :value="opt.value">{{ $t(opt.labelKey) }}</option>
      </select>
    </div>

    <h3 class="text-xs font-bold text-ui-dim uppercase mt-4 mb-2">{{ $t('settings.mouse.wheel') }}</h3>
    <div v-for="item in mouseWheelKeys" :key="item.key" class="flex items-center justify-between">
      <span class="text-sm">{{ $t(item.labelKey) }}</span>
      <select v-model="config[item.key]" class="bg-ui-hover text-ui-text border border-ui-border rounded px-2 py-1 text-sm w-40 outline-none">
        <option v-for="opt in actionKeys" :value="opt.value">{{ $t(opt.labelKey) }}</option>
      </select>
    </div>
  </div>
</template>
