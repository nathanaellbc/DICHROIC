const modalStack: HTMLElement[] = [];
/** Lapisan latar dialog (aria-hidden, klik = tutup). */
export const MODAL_SCRIM = '.scrim, .backdrop, .alert-scrim';
/** Elemen yang tidak pernah dibuat inert oleh dialog (lihat activateModal). */
export const MODAL_EXEMPT = '[data-modal-exempt]';
const inertOwners = new WeakMap<HTMLElement, { count: number; previous: boolean }>();

/** Trap keyboard focus and disable the background, including nested dialogs. */
export function activateModal(element: HTMLElement): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const background: HTMLElement[] = [];
  for (let branch: HTMLElement | null = element; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      // Latar modal (scrim/backdrop) menangkap ketukan untuk menutup: tidak boleh
      // ikut inert, kalau tidak ketukan di luar dialog tembus dan hilang.
      if (sibling.matches(MODAL_SCRIM)) continue;
      // Input berkas tersembunyi dibuka dari dalam menu (Open Photo… di More).
      // Bila ikut inert, iOS membuka pemilih foto tetapi berkas pilihan tidak
      // pernah sampai (foto tidak terbuka). Tidak fokus-able, jadi aman dikecualikan.
      if (sibling.matches(MODAL_EXEMPT)) continue;
      const owner = inertOwners.get(sibling) ?? { count: 0, previous: sibling.inert };
      owner.count += 1;
      inertOwners.set(sibling, owner);
      sibling.inert = true;
      background.push(sibling);
    }
    if (branch.parentElement === document.body) break;
  }
  modalStack.push(element);
  const top = () => modalStack.at(-1) === element;
  const tabbable = () => Array.from(element.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]'))
    .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0);
  const focusFirst = () => (tabbable()[0] ?? element).focus({ preventScroll: true });
  const onFocus = (event: FocusEvent) => {
    if (top() && event.target instanceof Node && !element.contains(event.target)) focusFirst();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!top() || event.key !== 'Tab') return;
    const nodes = tabbable();
    const first = nodes[0]; const last = nodes.at(-1);
    if (!first || (event.shiftKey && (document.activeElement === first || document.activeElement === element)) ||
        (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last ?? element : first ?? element).focus({ preventScroll: true });
    }
  };
  document.addEventListener('focusin', onFocus);
  document.addEventListener('keydown', onKey, true);
  element.tabIndex = -1;
  focusFirst();
  return () => {
    const wasTop = top();
    modalStack.splice(modalStack.indexOf(element), 1);
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('keydown', onKey, true);
    for (const sibling of background) {
      const owner = inertOwners.get(sibling)!;
      owner.count -= 1;
      if (owner.count === 0) { sibling.inert = owner.previous; inertOwners.delete(sibling); }
    }
    if (wasTop && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
  };
}
