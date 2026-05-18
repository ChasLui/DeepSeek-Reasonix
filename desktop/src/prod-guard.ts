// Release builds also drop the `devtools` Cargo feature, so the inspector
// is compiled out entirely — this only needs to handle the context menu.

// Inputs keep their native menu so copy/paste still works; everything else loses it.
function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

export function applyProductionLockdown(): void {
  if (import.meta.env.DEV) return;
  window.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
}
