import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface MenuAction {
  id?: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  danger?: boolean;
  onSelect: () => void;
}
export interface MenuAnchor {
  id: string;
  trigger: HTMLElement;
  point?: { x: number; y: number };
}

/** A viewport-contained menu, including when its trigger lives in a native dialog. */
export function DesktopMenu({
  anchor,
  label,
  header,
  actions,
  close,
}: {
  anchor: MenuAnchor;
  label: string;
  header?: ReactNode;
  actions: MenuAction[];
  close: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = anchor.trigger.getBoundingClientRect();
    const x = anchor.point?.x ?? box.right - element.offsetWidth;
    const y = anchor.point?.y ?? box.bottom + 8;
    setPosition({
      left: Math.max(
        12,
        Math.min(x, window.innerWidth - element.offsetWidth - 12),
      ),
      top: Math.max(
        12,
        Math.min(y, window.innerHeight - element.offsetHeight - 12),
      ),
    });
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !ref.current?.contains(event.target) &&
        !anchor.trigger.contains(event.target)
      )
        close(false);
    };
    const resize = () => close(true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [anchor, close]);
  return createPortal(
    <div
      ref={ref}
      className="desktop-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, visibility: "visible" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === "Tab") {
          close(true);
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const buttons = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? []),
          ];
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {header && (
        <div className="menu-identity" role="presentation">
          {header}
        </div>
      )}
      {actions.map((action) => (
        <div
          key={action.id ?? action.label}
          role="none"
          className={action.separator ? "menu-separator" : undefined}
        >
          <button
            role="menuitem"
            aria-label={action.label}
            disabled={action.disabled}
            className={action.danger ? "menu-danger" : undefined}
            onClick={() => {
              close(true);
              action.onSelect();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
            {action.shortcut && <kbd>{action.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    anchor.trigger.closest("dialog[open]") ?? document.body,
  );
}
