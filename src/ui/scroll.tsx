import { Box, type DOMElement, measureElement, useBoxMetrics } from "ink";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";

export interface ScrollMetrics {
  top: number;
  maxTop: number;
  height: number;
  itemTops: number[];
}

export const emptyScrollMetrics = (): ScrollMetrics => ({
  top: 0,
  maxTop: 0,
  height: 0,
  itemTops: [],
});

/** null follows the live tail; a number anchors an absolute terminal row. */
export function moveScroll(
  metrics: ScrollMetrics,
  delta: number,
): number | null {
  // There is nowhere to scroll until content actually overflows. Do not pause
  // following on a wheel-up event at startup, or future output would be hidden.
  if (metrics.maxTop <= 0) return null;
  const top = Math.max(0, Math.min(metrics.maxTop, metrics.top + delta));
  return delta > 0 && top === metrics.maxTop ? null : top;
}

/** Clip the actual Yoga layout, including partial messages, at terminal rows. */
export function ScrollViewport({
  items,
  top,
  metrics,
}: {
  items: { id: number; content: ReactNode }[];
  top: number | null;
  metrics: RefObject<ScrollMetrics>;
}) {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const itemRefs = useRef(new Map<number, DOMElement>());
  const viewSize = useBoxMetrics(viewport);
  const contentSize = useBoxMetrics(content);
  const maxTop = Math.max(0, contentSize.height - viewSize.height);
  const offset = top === null ? maxTop : Math.max(0, Math.min(top, maxTop));
  useLayoutEffect(() => {
    let row = 0;
    const itemTops = items.map((item) => {
      const start = row;
      const node = itemRefs.current.get(item.id);
      if (node) row += measureElement(node).height;
      return start;
    });
    metrics.current = {
      top: offset,
      maxTop,
      height: viewSize.height,
      itemTops,
    };
  });
  return (
    <Box
      ref={viewport}
      width="100%"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      <Box
        ref={content}
        position="absolute"
        top={-offset}
        width="100%"
        flexDirection="column"
        flexShrink={0}
      >
        {items.map((item) => (
          <Box
            key={item.id}
            ref={(node) => {
              if (node) itemRefs.current.set(item.id, node);
              else itemRefs.current.delete(item.id);
            }}
            width="100%"
            flexDirection="column"
            flexShrink={0}
          >
            {item.content}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
