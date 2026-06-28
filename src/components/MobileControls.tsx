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
            hold={!!control.hold}
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
  /** If true, fires action on press and `${action}:release` on release
   *  (for auto-fire). Otherwise fires action on release (tap-style). */
  hold?: boolean;
  onButtonAction?: (action: string) => void;
}

/** A single mobile button. Uses native touch listeners (passive: false) so we
 *  can preventDefault and avoid the 300ms tap delay / touch→click gap. Also
 *  supports mouse for desktop testing.
 *
 *  Two action modes:
 *   - Tap (default): fires `action` once on release (touchend / click).
 *     Used for jump, reload, switch weapon, pause.
 *   - Hold (hold=true): fires `action` on press (touchstart / mousedown) and
 *     `${action}:release` on release (touchend / mouseup). Used for the fire
 *     button so the weapon keeps firing while the button is held. */
function MobileButton({ x, y, size, color, icon, action, hold, onButtonAction }: MobileButtonProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether a "press" has been fired for hold-style buttons, so the
  // matching "release" only fires if the press actually went out (and so we
  // don't double-fire on stray mouseup without mousedown, etc.).
  const pressFiredRef = useRef(false);

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
      if (hold) {
        pressFiredRef.current = true;
        onButtonAction(action);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!touchActive) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchId) {
          touchActive = false;
          touchId = null;
          if (hold) {
            if (pressFiredRef.current) {
              pressFiredRef.current = false;
              onButtonAction(action + ':release');
            }
          } else {
            onButtonAction(action);
          }
          return;
        }
      }
    };
    const onTouchCancel = () => {
      // If a press was fired, fire the matching release so the engine
      // doesn't get stuck in "firing" state when a touch is interrupted
      // (e.g. by an incoming phone call, notification gesture, etc.).
      if (hold && pressFiredRef.current) {
        pressFiredRef.current = false;
        onButtonAction(action + ':release');
      }
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
  }, [action, hold, onButtonAction]);

  // Mouse handlers (desktop testing). For hold buttons, fire on mousedown
  // and release on mouseup. For tap buttons, fire on click only (avoids the
  // previous double-fire from having both mousedown and click handlers).
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hold) {
      pressFiredRef.current = true;
      onButtonAction?.(action);
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hold && pressFiredRef.current) {
      pressFiredRef.current = false;
      onButtonAction?.(action + ':release');
    }
  };

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hold) {
      onButtonAction?.(action);
    }
  };

  return (
    <div
      ref={nodeRef}
      data-mobile-btn="true"
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onClick={onClick}
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
