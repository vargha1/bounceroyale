import { useState, useRef, useCallback } from 'react';
import {
  CONTROLS_LAYER_STYLE,
  ControlIcon,
  DEFAULT_CONTROLS,
  MOBILE_LAYOUT_PRESETS,
  getControlScale,
  getLayoutPositions,
  loadCustomLayout,
  loadSelectedLayout,
  saveCustomLayout,
  saveSelectedLayout,
  type MobileLayoutPosition,
  type MobileLayoutType,
} from './MobileControls/';

interface Props {
  onClose: () => void;
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

const EDGE_MARGIN_PCT = 4;

/** Fullscreen editor that lets the user pick a preset or drag buttons around to
 *  create a custom layout. Opened from MainMenu / PauseModal. */
export default function MobileLayoutEditor({ onClose }: Props) {
  const [currentType, setCurrentType] = useState<MobileLayoutType>(() => loadSelectedLayout());
  const [positions, setPositions] = useState<Record<string, MobileLayoutPosition>>(() =>
    getLayoutPositions(loadSelectedLayout()),
  );
  const [scale] = useState(() => getControlScale());

  // The box the percentages are relative to — identical to the in-game layer.
  const layerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const currentTypeRef = useRef(currentType);
  currentTypeRef.current = currentType;
  const dragRef = useRef<{ id: string; pointerId: number; offX: number; offY: number } | null>(null);

  const switchLayoutType = useCallback((type: MobileLayoutType) => {
    setCurrentType(type);
    setPositions(getLayoutPositions(type));
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

  const resetCustom = useCallback(() => {
    const fresh = { ...MOBILE_LAYOUT_PRESETS.default.positions };
    setPositions(fresh);
    saveCustomLayout(fresh);
    setCurrentType('custom');
    saveSelectedLayout('custom');
    broadcastLayoutChange();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const layer = layerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const pos = positionsRef.current[id] ?? { x: 50, y: 50 };
    // Remember where inside the button the finger landed so it doesn't jump.
    const cx = rect.left + (pos.x / 100) * rect.width;
    const cy = rect.top + (pos.y / 100) * rect.height;
    dragRef.current = { id, pointerId: e.pointerId, offX: e.clientX - cx, offY: e.clientY - cy };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const layer = layerRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !layer) return;
    const rect = layer.getBoundingClientRect();
    const clamp = (v: number) => Math.max(EDGE_MARGIN_PCT, Math.min(100 - EDGE_MARGIN_PCT, v));
    const x = clamp(((e.clientX - drag.offX - rect.left) / rect.width) * 100);
    const y = clamp(((e.clientY - drag.offY - rect.top) / rect.height) * 100);
    // Move the node directly while dragging; state is committed on release.
    const node = e.currentTarget;
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    positionsRef.current = { ...positionsRef.current, [drag.id]: { x, y } };
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const next = { ...positionsRef.current };
    setPositions(next);
    // Only promote to "custom" if something actually moved.
    const before = currentTypeRef.current === 'custom' ? loadCustomLayout() : MOBILE_LAYOUT_PRESETS[currentTypeRef.current].positions;
    const p = next[drag.id];
    const b = before[drag.id];
    if (!b || Math.abs(p.x - b.x) > 0.05 || Math.abs(p.y - b.y) > 0.05) commitCustomPositions(next);
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    fontSize: '0.8rem',
    minHeight: '32px',
    background: active ? 'linear-gradient(135deg, #c084fc, #f472b6)' : 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '8px',
    color: 'white',
    cursor: 'pointer',
  });

  return (
    <div className="modal-overlay" style={{ zIndex: 100, padding: 0, background: 'rgba(0,0,0,0.92)' }}>
      {/* Same box as the in-game controls layer, so what you see is what you get. */}
      <div ref={layerRef} style={{ ...CONTROLS_LAYER_STYLE, touchAction: 'none' }}>
        {/* Top bar */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(560px, calc(100% - 20px))',
            background: 'rgba(20,16,36,0.95)',
            borderRadius: '12px',
            padding: '10px 12px',
            zIndex: 40,
            color: 'white',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '8px' }}>
            🎮 Mobile Layout — drag buttons to reposition
          </div>
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
            {(Object.keys(MOBILE_LAYOUT_PRESETS) as MobileLayoutType[]).map((type) => (
              <button key={type} onClick={() => switchLayoutType(type)} style={chipStyle(currentType === type)}>
                {MOBILE_LAYOUT_PRESETS[type].name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button onClick={resetCustom} style={chipStyle(false)}>
              ↻ Reset
            </button>
            <button
              onClick={onClose}
              style={{
                ...chipStyle(true),
                padding: '6px 18px',
                fontSize: '0.85rem',
                fontWeight: 700,
                border: 'none',
              }}
            >
              ✓ Done
            </button>
          </div>
        </div>

        {/* Guide: the left side is reserved for the move joystick */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '40%',
            borderRight: '1px dashed rgba(255,255,255,0.15)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 18,
            color: 'rgba(255,255,255,0.35)',
            fontSize: '0.75rem',
            pointerEvents: 'none',
          }}
        >
          Move joystick zone
        </div>

        {/* Draggable preview buttons */}
        {DEFAULT_CONTROLS.map((control) => {
          const pos = positions[control.id] ?? { x: 50, y: 50 };
          const size = Math.round(control.size * scale);
          return (
            <div
              key={control.id}
              onPointerDown={(e) => onPointerDown(e, control.id)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                position: 'absolute',
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                width: size,
                height: size,
                zIndex: 30,
                touchAction: 'none',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                borderRadius: '50%',
                background: `${control.color}b3`,
                border: `2px dashed ${control.color}`,
                boxShadow: `0 0 0 3px ${control.color}55`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                cursor: 'move',
              }}
            >
              <ControlIcon id={control.id} size={Math.round(size * 0.46)} />
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
