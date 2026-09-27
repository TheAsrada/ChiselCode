import { Box, type DOMElement, measureElement, useBoxMetrics } from "ink";
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  layoutKey,
}: {
  items: {
    id: number;
    content: ReactNode;
    height?: number;
    groupIndex?: number;
  }[];
  top: number | null;
  metrics: RefObject<ScrollMetrics>;
  layoutKey?: number;
}) {
  if (items.every((item) => item.height !== undefined))
    return (
      <VirtualViewport
        items={items}
        top={top}
        metrics={metrics}
        layoutKey={layoutKey}
      />
    );
  return <MeasuredViewport items={items} top={top} metrics={metrics} />;
}

/** Only visible messages participate in Yoga layout and terminal painting. */
function VirtualViewport({
  items,
  top,
  metrics,
  layoutKey,
}: {
  items: {
    id: number;
    content: ReactNode;
    height?: number;
    groupIndex?: number;
  }[];
  top: number | null;
  metrics: RefObject<ScrollMetrics>;
  layoutKey?: number;
}) {
  const viewport = useRef<DOMElement>(null);
  const size = useBoxMetrics(viewport);
  const previous = useRef({
    key: layoutKey,
    top,
    offset: 0,
    index: 0,
    within: 0,
  });
  const measured = useRef(
    new Map<number, { content: ReactNode; height: number }>(),
  );
  const nodes = useRef(new Map<number, DOMElement>());
  const [revision, setRevision] = useState(0);
  if (previous.current.key !== layoutKey) measured.current.clear();
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured heights and width invalidate cached offsets.
  const layout = useMemo(() => {
    let total = 0;
    const itemTops: number[] = [];
    const starts = items.map((item, index) => {
      const start = total;
      itemTops[item.groupIndex ?? index] ??= start;
      const cached = measured.current.get(item.id);
      total +=
        cached && cached.content === item.content
          ? cached.height
          : (item.height ?? 1);
      return start;
    });
    return { starts, total, itemTops };
  }, [items, revision, layoutKey]);
  const maxTop = Math.max(0, layout.total - size.height);
  // Preserve the message being read across reflow, not a stale absolute row.
  let requested = top;
  if (top !== null && previous.current.top === top) {
    requested =
      (layout.starts[previous.current.index] ?? 0) +
      previous.current.within +
      (top - previous.current.offset);
  }
  const offset =
    top === null ? maxTop : Math.max(0, Math.min(requested ?? 0, maxTop));
  let first = 0;
  let end = items.length;
  while (first + 1 < end) {
    const middle = Math.floor((first + end) / 2);
    if ((layout.starts[middle] ?? 0) <= offset) first = middle;
    else end = middle;
  }
  const visible: typeof items = [];
  for (let index = Math.max(0, first - 1); index < items.length; index++) {
    if ((layout.starts[index] ?? 0) > offset + size.height + 3) break;
    const item = items[index];
    if (item) visible.push(item);
  }
  const start = Math.max(0, first - 1);
  useLayoutEffect(() => {
    let changed = false;
    for (const item of visible) {
      const node = nodes.current.get(item.id);
      if (!node) continue;
      const height = measureElement(node).height;
      const old = measured.current.get(item.id);
      if (
        height > 0 &&
        (old?.height !== height || old.content !== item.content)
      ) {
        measured.current.set(item.id, { content: item.content, height });
        if (height !== (old?.height ?? item.height)) changed = true;
      }
    }
    previous.current = {
      key: layoutKey,
      top,
      offset: top ?? offset,
      index: first,
      within: offset - (layout.starts[first] ?? 0),
    };
    metrics.current = {
      top: offset,
      maxTop,
      height: size.height,
      itemTops: layout.itemTops,
    };
    if (changed) setRevision((value) => value + 1);
  });
  useLayoutEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    for (const id of measured.current.keys())
      if (!ids.has(id)) measured.current.delete(id);
  }, [items]);
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
        position="absolute"
        top={(layout.starts[start] ?? 0) - offset}
        width="100%"
        flexDirection="column"
        flexShrink={0}
      >
        {visible.map((item) => (
          <Box
            key={item.id}
            ref={(node) => {
              if (node) nodes.current.set(item.id, node);
              else nodes.current.delete(item.id);
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

function MeasuredViewport({
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
