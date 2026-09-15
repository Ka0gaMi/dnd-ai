// Dropping an image on a portrait uploads it. Mouse only, like the rest of the map affordances.
export interface DropImage {
  ondrop: (file: File) => void;
}

/** `use:dropImage={{ ondrop }}`: highlights while an image hovers and hands the file over. */
export function dropImage(node: HTMLElement, options: DropImage): { destroy: () => void } {
  const imageOf = (event: DragEvent): File | null => {
    const file = event.dataTransfer?.files?.[0] ?? null;
    return file && file.type.startsWith('image/') ? file : null;
  };

  const over = (event: DragEvent): void => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    node.classList.add('dropping');
  };
  const leave = (): void => node.classList.remove('dropping');
  const drop = (event: DragEvent): void => {
    event.preventDefault();
    node.classList.remove('dropping');
    const file = imageOf(event);
    if (file) options.ondrop(file);
  };

  node.addEventListener('dragover', over);
  node.addEventListener('dragleave', leave);
  node.addEventListener('drop', drop);

  return {
    destroy() {
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    },
  };
}
