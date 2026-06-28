import { useRef, useEffect, useState } from 'react';
import {
  DEFAULT_CONTROLS,
  MOBILE_LAYOUT_PRESETS,
  loadCustomLayout,
  loadSelectedLayout,
  type MobileLayoutType,
  type MobileLayoutPosition,
} from './MobileControls/';

interface Props {
  onButtonAction?: (action: string) => void;
}

function getPositionsForType(type: MobileLayoutType): Record<string, MobileLayoutPosition> {
  if (type === 'custom') return loadCustomLayout();
  return { ...MOBILE_LAYOUT_PRESETS[type].positions };
}

export default function MobileControls({ onButtonAction }: Props) {
  const [layoutType, setLayoutType] = useState<MobileLayoutType>(() => loadSelectedLayout());
  const [positions, setPositions] = useState<Record<string, MobileLayoutPosition>>(() =>
    getPositionsForType(loadSelectedLayout())
  );

  // Re-read layout when the storage changes (e.g. user edits via the menu)
  useEffect(() => {
    const onStorage = () => {
      const next = loadSelectedLayout();
      setLayoutType(next);
      setPositions(getPositionsForType(next));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('mobile-layout-changed', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mobile-layout-changed', onStorage);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 45,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {DEFAULT_CONTROLS.map((control) => {
        const pos = positions[control.id] ?? { x: 50, y: 50 };
        return (
          <MobileButton
            key={control.id + ':' + layoutType}
            x={pos.x}
            y={pos.y}
            size={control.size}
            color={control.color}
            icon={control.icon}
            action={control.action}
            onButtonAction={onButtonAction}
          />
        );
      })}
    </div>
  );
}

interface MobileButtonProps {
  x: number;
  y: number;
  size: number;
  color: string;
  icon: string;
  action: string;
  onButtonAction?: (action: string) => void;
}

/** A single mobile button. Uses native touch listeners (passive: false) so we
 *  can preventDefault and avoid the 300ms tap delay / touch→click gap. Also
 *  supports mouse for desktop testing. */
function MobileButton({ x, y, size, color, icon, action, onButtonAction }: MobileButtonProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !onButtonAction) return;

    let touchActive = false;
    let touchId: number | null = null;

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.changedTouches.length === 0) return;
      const touch = e.changedTouches[0];
      touchActive = true;
      touchId = touch.identifier;
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!touchActive) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchId) {
          touchActive = false;
          touchId = null;
          onButtonAction(action);
          return;
        }
      }
    };
    const onTouchCancel = () => {
      touchActive = false;
      touchId = null;
    };

    const opts: AddEventListenerOptions = { passive: false };
    node.addEventListener('touchstart', onTouchStart, opts);
    node.addEventListener('touchend', onTouchEnd, opts);
    node.addEventListener('touchcancel', onTouchCancel, opts);

    return () => {
      node.removeEventListener('touchstart', onTouchStart, opts);
      node.removeEventListener('touchend', onTouchEnd, opts);
      node.removeEventListener('touchcancel', onTouchCancel, opts);
    };
  }, [action, onButtonAction]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onButtonAction?.(action);
  };

  return (
    <div
      ref={nodeRef}
      data-mobile-btn="true"
      onMouseDown={onMouseDown}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onButtonAction?.(action);
      }}
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: 'translate(-50%, -50%)',
        zIndex: 46,
        pointerEvents: 'auto',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        color: 'white',
        fontWeight: 700,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        border: '1px solid rgba(255,255,255,0.2)',
        cursor: 'pointer',
      }}
    >
      {icon}
    </div>
  );
}

export type { MobileLayoutType, MobileLayoutPosition };
