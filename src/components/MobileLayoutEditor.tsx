import { useState, useRef, useEffect, useCallback } from 'react';
import {
  DEFAULT_CONTROLS,
  MOBILE_LAYOUT_PRESETS,
  loadCustomLayout,
  saveCustomLayout,
  loadSelectedLayout,
  saveSelectedLayout,
  type MobileLayoutType,
  type MobileLayoutPosition,
} from './MobileControls/';

interface Props {
  onClose: () => void;
}

const DRAG_THRESHOLD_PX = 5;

function getPositionsForType(type: MobileLayoutType): Record<string, MobileLayoutPosition> {
  if (type === 'custom') return loadCustomLayout();
  return { ...MOBILE_LAYOUT_PRESETS[type].positions };
}

/** Notifies any mounted MobileControls component that the saved layout changed
 *  so it can re-read positions without a full reload. */
function broadcastLayoutChange() {
  try {
    window.dispatchEvent(new Event('mobile-layout-changed'));
  } catch {
    /* ignore */
  }
}

/** Fullscreen editor that lets the user pick a preset or drag buttons around to
 *  create a custom layout. Opened from MainMenu / PauseModal. */
export default function MobileLayoutEditor({ onClose }: Props) {
  const [currentType, setCurrentType] = useState<MobileLayoutType>(() => loadSelectedLayout());
  const [positions, setPositions] = useState<Record<string, MobileLayoutPosition>>(() =>
    getPositionsForType(loadSelectedLayout())
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const currentTypeRef = useRef(currentType);
  currentTypeRef.current = currentType;

  // When user picks a preset, load its positions. If they then drag, we
  // promote to 'custom' and save the result.
  useEffect(() => {
    setPositions(getPositionsForType(currentType));
  }, [currentType]);

  const switchLayoutType = useCallback((type: MobileLayoutType) => {
    setCurrentType(type);
    saveSelectedLayout(type);
    broadcastLayoutChange();
  }, []);

  const commitCustomPositions = useCallback((next: Record<string, MobileLayoutPosition>) => {
    saveCustomLayout(next);
    if (currentTypeRef.current !== 'custom') {
      setCurrentType('custom');
      saveSelectedLayout('custom');
    }
    broadcastLayoutChange();
  }, []);

  const buttonNodesRef = useRef<Record<string, HTMLDivElement | null>>({});
  const dragStateRef = useRef<Record<string, {
    startX: number;
    startY: number;
    touchId: number | null;
    isDragging: boolean;
    isMouse: boolean;
  }>>({});

  useEffect(() => {
    const cleanups: (() => void)[] = [];

    for (const control of DEFAULT_CONTROLS) {
      const node = buttonNodesRef.current[control.id];
      if (!node) continue;
      const id = control.id;

      const startDrag = (clientX: number, clientY: number, touchId: number | null, isMouse: boolean) => {
        dragStateRef.current[id] = { startX: clientX, startY: clientY, touchId, isDragging: false, isMouse };
      };

      const moveDrag = (clientX: number, clientY: number, touchId: number | null) => {
        const state = dragStateRef.current[id];
        if (!state) return;
        if (touchId !== null && state.touchId !== touchId) return;
        const dist = Math.hypot(clientX - state.startX, clientY - state.startY);
        if (dist > DRAG_THRESHOLD_PX) state.isDragging = true;
        if (!state.isDragging) return;
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const x = Math.max(5, Math.min(95, ((clientX - rect.left) / rect.width) * 100));
        const y = Math.max(5, Math.min(95, ((clientY - rect.top) / rect.height) * 100));
        const next = { ...positionsRef.current, [id]: { x, y } };
        positionsRef.current = next;
        node.style.left = `${x}%`;
        node.style.top = `${y}%`;
      };

      const endDrag = (touchId: number | null) => {
        const state = dragStateRef.current[id];
        if (!state) return;
        if (touchId !== null && state.touchId !== touchId) return;
        if (state.isDragging) {
          setPositions({ ...positionsRef.current });
          commitCustomPositions(positionsRef.current);
        }
        delete dragStateRef.current[id];
      };

      const onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const touch = e.changedTouches[0];
        if (!touch) return;
        startDrag(touch.clientX, touch.clientY, touch.identifier, false);
      };
      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          moveDrag(t.clientX, t.clientY, t.identifier);
        }
      };
      const onTouchEnd = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
          endDrag(e.changedTouches[i].identifier);
        }
      };

      const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientX, e.clientY, null, true);
      };

      const opts: AddEventListenerOptions = { passive: false };
      node.addEventListener('touchstart', onTouchStart, opts);
      node.addEventListener('touchmove', onTouchMove, opts);
      node.addEventListener('touchend', onTouchEnd, opts);
      node.addEventListener('touchcancel', onTouchEnd, opts);
      node.addEventListener('mousedown', onMouseDown);

      cleanups.push(() => {
        node.removeEventListener('touchstart', onTouchStart, opts);
        node.removeEventListener('touchmove', onTouchMove, opts);
        node.removeEventListener('touchend', onTouchEnd, opts);
        node.removeEventListener('touchcancel', onTouchEnd, opts);
        node.removeEventListener('mousedown', onMouseDown);
      });
    }

    // Window-level mousemove/mouseup so dragging continues even if the cursor
    // leaves the button.
    const onWindowMouseMove = (e: MouseEvent) => {
      for (const id of Object.keys(dragStateRef.current)) {
        const state = dragStateRef.current[id];
        if (!state.isMouse) continue;
        const dist = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
        if (dist > DRAG_THRESHOLD_PX) state.isDragging = true;
        if (!state.isDragging || !containerRef.current) continue;
        const node = buttonNodesRef.current[id];
        if (!node) continue;
        const rect = containerRef.current.getBoundingClientRect();
        const x = Math.max(5, Math.min(95, ((e.clientX - rect.left) / rect.width) * 100));
        const y = Math.max(5, Math.min(95, ((e.clientY - rect.top) / rect.height) * 100));
        const next = { ...positionsRef.current, [id]: { x, y } };
        positionsRef.current = next;
        node.style.left = `${x}%`;
        node.style.top = `${y}%`;
      }
    };
    const onWindowMouseUp = () => {
      let anyDragged = false;
      for (const id of Object.keys(dragStateRef.current)) {
        if (!dragStateRef.current[id].isMouse) continue;
        if (dragStateRef.current[id].isDragging) anyDragged = true;
        delete dragStateRef.current[id];
      }
      if (anyDragged) {
        setPositions({ ...positionsRef.current });
        commitCustomPositions(positionsRef.current);
      }
    };
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    cleanups.push(() => {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
    });

    return () => cleanups.forEach((c) => c());
  }, [commitCustomPositions]);

  const resetCustom = useCallback(() => {
    const fresh = { ...MOBILE_LAYOUT_PRESETS.default.positions };
    setPositions(fresh);
    saveCustomLayout(fresh);
    setCurrentType('custom');
    saveSelectedLayout('custom');
    broadcastLayoutChange();
  }, []);

  return (
    <div className="modal-overlay" style={{ zIndex: 100 }}>
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.92)',
          overflow: 'hidden',
        }}
      >
        {/* Top bar */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            right: 10,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            padding: '12px',
            zIndex: 40,
            color: 'white',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '10px' }}>
            🎮 Mobile Layout — Drag buttons to reposition
          </div>
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
            {(Object.keys(MOBILE_LAYOUT_PRESETS) as MobileLayoutType[]).map((type) => (
              <button
                key={type}
                onClick={() => switchLayoutType(type)}
                style={{
                  padding: '6px 12px',
                  fontSize: '0.8rem',
                  minHeight: '30px',
                  background:
                    currentType === type
                      ? 'linear-gradient(135deg, #c084fc, #f472b6)'
                      : 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  color: 'white',
                  cursor: 'pointer',
                }}
              >
                {MOBILE_LAYOUT_PRESETS[type].name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button
              onClick={resetCustom}
              style={{
                padding: '6px 14px',
                fontSize: '0.8rem',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                color: 'white',
                cursor: 'pointer',
              }}
            >
              ↻ Reset
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '6px 18px',
                fontSize: '0.85rem',
                background: 'linear-gradient(135deg, #c084fc, #f472b6)',
                border: 'none',
                borderRadius: '8px',
                color: 'white',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ✓ Done
            </button>
          </div>
        </div>

        {/* Draggable preview buttons */}
        {DEFAULT_CONTROLS.map((control) => {
          const pos = positions[control.id] ?? { x: 50, y: 50 };
          return (
            <div
              key={control.id}
              ref={(node) => { buttonNodesRef.current[control.id] = node; }}
              style={{
                position: 'absolute',
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 30,
                touchAction: 'none',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                width: control.size,
                height: control.size,
                borderRadius: '50%',
                background: `${control.color}aa`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: control.size * 0.4,
                color: 'white',
                fontWeight: 700,
                boxShadow: `0 0 0 3px ${control.color}, 0 4px 16px rgba(0,0,0,0.3)`,
                border: `2px dashed ${control.color}`,
                cursor: 'move',
              }}
            >
              {control.icon}
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: '10px',
                  color: 'white',
                  background: 'rgba(0,0,0,0.7)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  whiteSpace: 'nowrap',
                  marginTop: '2px',
                  pointerEvents: 'none',
                }}
              >
                {control.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
