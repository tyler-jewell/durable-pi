<script setup lang="ts">
// A modal dialog on the native <dialog> element: showModal() gives the inert page, focus containment,
// the top layer, Esc and focus return. The parent controls what is shown; this emits close.
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{ labelledby: string; dismissable?: boolean }>(), {
  dismissable: true,
});
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let announced = false;

function onCancel(event: Event) {
  if (!props.dismissable) event.preventDefault();
}

function onClose() {
  if (announced) return;
  announced = true;
  emit("close");
}

// A click on the backdrop lands on the dialog element, outside its box.
function onClick(event: MouseEvent) {
  const box = dialog.value?.getBoundingClientRect();
  if (!props.dismissable || !box) return;
  const inside =
    event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom;
  if (!inside) dialog.value?.close();
}

onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => {
  announced = true;
  if (dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    :aria-labelledby="labelledby"
    @cancel="onCancel"
    @close="onClose"
    @click="onClick"
  >
    <slot />
  </dialog>
</template>
