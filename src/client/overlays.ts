import { el } from "./dom";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

export interface Overlay {
  close(): void;
  readonly open: boolean;
}

interface ModalOptions {
  popup: HTMLElement;
  onClose?(): void;
}

export function openModal({ popup, onClose }: ModalOptions): Overlay {
  const backdrop = el("div", { class: "dialog-backdrop" });
  const restoreFocus = document.activeElement;
  let open = true;

  const close = () => {
    if (!open) return;
    open = false;
    document.removeEventListener("keydown", onKeyDown, true);
    void transitionOut(backdrop);
    void transitionOut(popup);
    if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
    onClose?.();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      trapTab(popup, event);
    }
  };

  backdrop.addEventListener("pointerdown", close);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.append(backdrop, popup);
  transitionIn(backdrop);
  transitionIn(popup);
  focusFirst(popup);

  return {
    close,
    get open() {
      return open;
    },
  };
}

interface PopoverOptions {
  trigger: HTMLElement;
  popup: HTMLElement;
  sideOffset?: number;
  onClose?(): void;
}

export function openPopover({
  trigger,
  popup,
  sideOffset = 8,
  onClose,
}: PopoverOptions): Overlay {
  const positioner = el("div", { class: "keys-positioner" }, popup);
  let open = true;

  const close = () => {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("resize", position);
    void transitionOut(popup).then(() => positioner.remove());
    onClose?.();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
    } else if (event.key === "Tab") {
      trapTab(popup, event);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!positioner.contains(target) && !trigger.contains(target)) close();
  };

  // The popup hangs below the trigger with its right edges aligned, the way
  // the previous floating-ui positioner placed it.
  const position = () => {
    const anchor = trigger.getBoundingClientRect();
    const width = popup.offsetWidth;
    const left = Math.max(
      8,
      Math.min(anchor.right - width, window.innerWidth - width - 8),
    );
    positioner.style.top = `${anchor.bottom + sideOffset}px`;
    positioner.style.left = `${left}px`;
    popup.style.setProperty(
      "--transform-origin",
      `top ${anchor.right - left}px`,
    );
  };

  positioner.style.position = "fixed";
  trigger.setAttribute("aria-expanded", "true");
  document.body.append(positioner);
  position();
  transitionIn(popup);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("resize", position);

  return {
    close,
    get open() {
      return open;
    },
  };
}

function focusFirst(container: HTMLElement) {
  const target = container.querySelector<HTMLElement>(FOCUSABLE);
  (target ?? container).focus();
}

function trapTab(container: HTMLElement, event: KeyboardEvent) {
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// The stylesheet animates through these attributes, so an overlay enters one
// frame after it mounts and leaves only once its transition has finished.
function transitionIn(element: HTMLElement) {
  element.setAttribute("data-starting-style", "");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => element.removeAttribute("data-starting-style")),
  );
}

function transitionOut(element: HTMLElement): Promise<void> {
  element.setAttribute("data-ending-style", "");
  return new Promise((resolve) => {
    const finish = () => {
      element.remove();
      resolve();
    };
    element.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 300);
  });
}
