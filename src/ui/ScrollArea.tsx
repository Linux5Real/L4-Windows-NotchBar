import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Scroll container with a thin overlay scrollbar in the notch style.
 *
 * WebView2 draws the bright system scrollbar otherwise: `scrollbar-width: thin`
 * alone only makes it smaller, and once a standard scrollbar property is set
 * the `::-webkit-scrollbar` styles are ignored. So the native bar is hidden
 * completely and the thumb is drawn here: it follows the scroll position, can
 * be dragged, and sits on the inline-end edge (right in LTR, left in RTL).
 */
export function ScrollArea({
  children,
  className = "",
  thumbClassName = "",
  style,
}: {
  /** Classes for the scrolling element (size, padding, text styles). */
  className?: string;
  children: ReactNode;
  /** Extra classes for the thumb, e.g. a different color. */
  thumbClassName?: string;
  /** Inline metrics for the viewport, e.g. a computed max height. */
  style?: CSSProperties;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startTop: number } | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [dragging, setDragging] = useState(false);

  /** Reads the scroll metrics and places the thumb without re-rendering. */
  const sync = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const max = scrollHeight - clientHeight;
    const over = max > 1;
    setOverflowing((prev) => (prev === over ? prev : over));
    if (!over) {
      // Content shrank below the viewport while dragging.
      if (drag.current) {
        drag.current = null;
        setDragging(false);
      }
      return;
    }
    const bar = thumb.current;
    if (!bar) return; // Rendered after the state update; the effect below places it.
    // The track is inset by 4px on both ends; the thumb travels inside it.
    const track = Math.max(0, clientHeight - 8);
    const height = Math.max(18, Math.min(track, (track * clientHeight) / scrollHeight));
    const top = (track - height) * (scrollTop / max);
    bar.style.height = `${height}px`;
    bar.style.transform = `translateY(${top}px)`;
  }, []);

  useLayoutEffect(() => {
    sync();
    const el = viewport.current;
    const content = inner.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    observer.observe(content);
    el.addEventListener("scroll", sync, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", sync);
    };
  }, [sync]);

  // The thumb exists only after `overflowing` flipped, so place it once mounted.
  useLayoutEffect(() => {
    if (overflowing) sync();
  }, [overflowing, sync]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = viewport.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startTop: el.scrollTop };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = viewport.current;
    const start = drag.current;
    if (!el || !start) return;
    const max = el.scrollHeight - el.clientHeight;
    const track = Math.max(0, el.clientHeight - 8);
    const travel = track - Math.max(18, Math.min(track, (track * el.clientHeight) / el.scrollHeight));
    if (max <= 0 || travel <= 0) return;
    el.scrollTop = start.startTop + ((e.clientY - start.startY) / travel) * max;
  };

  const stopDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="relative min-w-0">
      <div
        ref={viewport}
        style={style}
        className={`overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      >
        <div ref={inner}>{children}</div>
      </div>
      {overflowing && (
        <div aria-hidden className="pointer-events-none absolute inset-y-1 end-1 w-2">
          <div
            ref={thumb}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            className={`pointer-events-auto absolute end-0 top-0 w-[5px] touch-none rounded-full bg-label-3/70 transition-colors duration-150 hover:bg-label-2 ${
              dragging ? "cursor-grabbing bg-label-2" : "cursor-grab"
            } ${thumbClassName}`}
          />
        </div>
      )}
    </div>
  );
}
