"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  computeRibbonPlacement,
  isOutsideRibbon,
  NEW_ENTRY_OPTIONS,
  ribbonKeyAction,
  type NewEntryKind,
  type RibbonPlacement,
} from "../lib/new-entry";

function NewEntryIcon({ kind }: { kind: NewEntryKind }) {
  if (kind === "expense") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 17 17 7" />
        <path d="M8 7h9v9" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 7 7 17" />
      <path d="M16 17H7V8" />
    </svg>
  );
}

/**
 * Header "+ New" button. Opens a small floating ribbon offering Expense or
 * Money In. The ribbon is portalled and fixed-positioned so the header layout
 * never shifts.
 */
export function NewEntryButton({
  onSelect,
  onOpen,
}: {
  onSelect: (kind: NewEntryKind) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<RibbonPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const ribbon = ribbonRef.current;
    if (!trigger || !ribbon) return;
    const rect = trigger.getBoundingClientRect();
    setPlacement(
      computeRibbonPlacement({
        anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        ribbon: { width: ribbon.scrollWidth, height: ribbon.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  const isPlaced = placement != null;
  useEffect(() => {
    if (!open || !isPlaced) return;
    itemRefs.current[0]?.focus({ preventScroll: true });
  }, [open, isPlaced]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (isOutsideRibbon(event.target as Node | null, triggerRef.current, ribbonRef.current)) {
        close(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    }
    function onResize() {
      place();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, place]);

  function choose(kind: NewEntryKind) {
    close(false);
    onSelect(kind);
  }

  function onItemKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const action = ribbonKeyAction(event.key, index, NEW_ENTRY_OPTIONS.length);
    if (!action) return;
    if (action.type === "focus") {
      event.preventDefault();
      itemRefs.current[action.index]?.focus();
      return;
    }
    if (action.restoreFocus) event.preventDefault();
    close(action.restoreFocus);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`fb-topbar-new-expense${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          onOpen?.();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowLeft")) {
            event.preventDefault();
            onOpen?.();
            setOpen(true);
          }
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        New
      </button>
      {open
        ? createPortal(
            <div
              ref={ribbonRef}
              id={menuId}
              role="menu"
              aria-label="Create new"
              aria-orientation="horizontal"
              className={`fb-new-ribbon${placement ? ` is-placed fb-new-ribbon--${placement.side}` : ""}`}
              style={
                placement
                  ? {
                      top: placement.top,
                      left: placement.left,
                      maxWidth: placement.maxWidth ?? undefined,
                    }
                  : undefined
              }
            >
              {NEW_ENTRY_OPTIONS.map((option, index) => (
                <button
                  key={option.kind}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  className={`fb-new-ribbon-item fb-new-ribbon-item--${option.kind}`}
                  title={option.hint}
                  onClick={() => choose(option.kind)}
                  onKeyDown={(event) => onItemKeyDown(event, index)}
                >
                  <span className="fb-new-ribbon-icon">
                    <NewEntryIcon kind={option.kind} />
                  </span>
                  <span className="fb-new-ribbon-label">{option.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
