<script setup lang="ts">
import { ref } from 'vue';
import { useModalKeyboardGuard } from '../composables/useModalKeyboardGuard';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  confirmText: 'Confirm',
  cancelText: 'Cancel',
  danger: false,
});

const emit = defineEmits<{
  'update:visible': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const panelRef = ref<HTMLDivElement | null>(null);

void panelRef;

function handleConfirm() {
  emit('confirm');
  emit('update:visible', false);
}

function handleCancel() {
  emit('cancel');
  emit('update:visible', false);
}

useModalKeyboardGuard({
  visible: () => props.visible,
  onEscape: handleCancel,
  onEnter: handleConfirm,
});
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div
        v-if="visible"
        class="fixed inset-x-0 top-8 bottom-0 z-[150] bg-black/60 backdrop-blur-sm flex justify-center items-center"
        @click.self="handleCancel"
      >
        <div
          ref="panelRef"
          class="bg-ui-bg w-100 max-w-[90vw] rounded-xl shadow-2xl border border-ui-border text-ui-text overflow-hidden"
          role="dialog"
          aria-modal="true"
        >
          <div class="px-5 py-4 border-b border-ui-border flex items-center gap-3">
            <div
              v-if="danger"
              class="i-mdi-alert-circle text-2xl text-red-500 shrink-0"
            ></div>
            <div
              v-else
              class="i-mdi-help-circle-outline text-2xl text-blue-500 shrink-0"
            ></div>
            <h3 class="font-medium text-base m-0">{{ title }}</h3>
          </div>

          <div class="px-5 py-4 text-sm text-ui-text/90 whitespace-pre-line">
            {{ message }}
          </div>

          <div class="px-5 py-3 bg-ui-hover flex justify-end gap-2 border-t border-ui-border">
            <button
              class="px-4 py-1.5 rounded text-sm bg-transparent text-ui-text hover:bg-ui-border border-none cursor-pointer"
              @click="handleCancel"
            >
              {{ cancelText }}
            </button>
            <button
              class="px-4 py-1.5 rounded text-sm text-white border-none cursor-pointer"
              :class="danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'"
              @click="handleConfirm"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.15s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>