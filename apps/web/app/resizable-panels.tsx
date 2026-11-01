'use client';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
export function ResizablePanels({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ wide: 38, narrow: 45 });
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = matchMedia('(max-width: 1199px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    try {
      const value = JSON.parse(
        localStorage.getItem('m2d:panel-size') ?? 'null',
      ) as typeof size | null;
      if (value && Number.isFinite(value.wide) && Number.isFinite(value.narrow))
        setSize({
          wide: Math.max(25, Math.min(65, value.wide)),
          narrow: Math.max(25, Math.min(70, value.narrow)),
        });
    } catch {
      // A malformed saved size must not prevent opening the panels.
    }
    return () => media.removeEventListener('change', update);
  }, []);
  const resize = (value: number) => {
    setSize((old) => {
      const next = {
        ...old,
        [narrow ? 'narrow' : 'wide']: Math.max(
          25,
          Math.min(narrow ? 70 : 65, value),
        ),
      };
      localStorage.setItem('m2d:panel-size', JSON.stringify(next));
      return next;
    });
  };
  return (
    <div
      ref={root}
      className={`portfolio-agent-layout ${open ? 'agent-open' : ''}`}
      style={
        {
          '--agent-width': `${size.wide}%`,
          '--agent-height': `${size.narrow}dvh`,
        } as CSSProperties
      }
    >
      {children}
      <div
        hidden={!open}
        className="panel-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize Advisor panel"
        aria-orientation={narrow ? 'horizontal' : 'vertical'}
        aria-valuemin={25}
        aria-valuemax={narrow ? 70 : 65}
        aria-valuenow={narrow ? size.narrow : size.wide}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const box = root.current?.getBoundingClientRect();
          if (box)
            resize(
              narrow
                ? ((innerHeight - e.clientY) / innerHeight) * 100
                : ((box.right - e.clientX) / box.width) * 100,
            );
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={(e) => {
          const increment =
            e.key === 'ArrowLeft' || e.key === 'ArrowUp'
              ? 2
              : e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? -2
                : 0;
          if (increment) {
            e.preventDefault();
            resize((narrow ? size.narrow : size.wide) + increment);
          }
        }}
      />
    </div>
  );
}
