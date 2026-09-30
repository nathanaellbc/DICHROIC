const modalStack: HTMLElement[] = [];
const inertOwners = new WeakMap<HTMLElement, { count: number; previous: boolean }>();

/** Trap keyboard focus and disable the background, including nested dialogs. */
export function activateModal(element: HTMLElement): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const background: HTMLElement[] = [];
  for (let branch: HTMLElement | null = element; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
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
