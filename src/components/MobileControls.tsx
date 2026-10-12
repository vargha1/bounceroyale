import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTROLS_LAYER_STYLE,
  ControlIcon,
  DEFAULT_CONTROLS,
  getControlScale,
  getLayoutPositions,
  isTouchPrimary,
  loadSelectedLayout,
  type MobileLayoutPosition,
  type MobileLayoutType,
} from './MobileControls/';

interface Props {
  onButtonAction?: (action: string) => void;
}

/** In-game touch buttons. Only mounted on touch-first devices; positions come
 *  from the selected preset / custom layout and update live when the layout
 *  editor changes them. */
function MobileControls({ onButtonAction }: Props) {
  const [touch] = useState(() => isTouchPrimary());
  const [positions, setPositions] = useState<Record<string, MobileLayoutPosition>>(() =>
    getLayoutPositions(loadSelectedLayout()),
  );
  const [scale, setScale] = useState(() => getControlScale());

  // Re-read the layout when it is edited (menu / pause editor).
  useEffect(() => {
    const onLayoutChanged = () => setPositions(getLayoutPositions(loadSelectedLayout()));
    window.addEventListener('storage', onLayoutChanged);
    window.addEventListener('mobile-layout-changed', onLayoutChanged);
    return () => {
      window.removeEventListener('storage', onLayoutChanged);
      window.removeEventListener('mobile-layout-changed', onLayoutChanged);
    };
  }, []);

  // Orientation change / resize → re-scale the buttons.
  useEffect(() => {
    const onResize = () => setScale(getControlScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!touch) return null;

  return (
    <div style={{ ...CONTROLS_LAYER_STYLE, zIndex: 45, pointerEvents: 'none', overflow: 'hidden' }}>
      {DEFAULT_CONTROLS.map((control) => {
        const pos = positions[control.id] ?? { x: 50, y: 50 };
        return (
          <MobileButton
            key={control.id}
            id={control.id}
            label={control.label}
            x={pos.x}
            y={pos.y}
            size={Math.round(control.size * scale)}
            color={control.color}
            action={control.action}
            hold={!!control.hold}
            fireOnRelease={!!control.fireOnRelease}
            onButtonAction={onButtonAction}
          />
        );
      })}
    </div>
  );
}

export default memo(MobileControls);

interface MobileButtonProps {
  id: string;
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  action: string;
  /** Fire `action` on press and `${action}:release` on release (auto-fire). */
  hold: boolean;
  /** Fire `action` when the finger lifts instead of on press. */
  fireOnRelease: boolean;
  onButtonAction?: (action: string) => void;
}

/** A single touch button, driven by Pointer Events: one code path for finger,
 *  stylus and mouse, with pointer capture so the release is always delivered
 *  even if the finger slides off the button while firing.
 *
 *  The pressed look is applied through a data attribute on the DOM node (not
 *  React state) so holding fire never re-renders anything. */
function MobileButton({ id, label, x, y, size, color, action, hold, fireOnRelease, onButtonAction }: MobileButtonProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const activePointer = useRef<number | null>(null);
  const callbackRef = useRef(onButtonAction);
  callbackRef.current = onButtonAction;

  const release = useCallback(
    (fireTap: boolean) => {
      if (activePointer.current === null) return;
      activePointer.current = null;
      const node = nodeRef.current;
      if (node) node.removeAttribute('data-pressed');
      if (hold) callbackRef.current?.(action + ':release');
      else if (fireOnRelease && fireTap) callbackRef.current?.(action);
    },
    [action, hold, fireOnRelease],
  );

  // Never leave the weapon stuck in "firing" if the button disappears or the
  // page loses focus mid-press (incoming call, notification shade, ...).
  useEffect(() => {
    const onBlur = () => release(false);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      release(false);
    };
  }, [release]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (activePointer.current !== null) return;
    activePointer.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore — capture is a nicety */
    }
    e.currentTarget.setAttribute('data-pressed', '1');
    if (hold || !fireOnRelease) {
      callbackRef.current?.(action);
      if (!hold && typeof navigator.vibrate === 'function') navigator.vibrate(8);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    release(true);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return;
    release(false);
  };

  const isFire = id === 'fire';
  const half = size / 2;

  return (
    <div
      ref={nodeRef}
      data-mobile-btn="true"
      className="mobile-btn"
      role="button"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        marginLeft: -half,
        marginTop: -half,
        width: size,
        height: size,
        borderRadius: '50%',
        color: '#fff',
        // Translucent so the controls never hide the action underneath.
        background: `radial-gradient(circle at 35% 30%, ${color}d9, ${color}8c)`,
        border: `${isFire ? 3 : 2}px solid rgba(255,255,255,${isFire ? 0.4 : 0.3})`,
        boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: 'pointer',
      }}
    >
      <ControlIcon id={id} size={Math.round(size * 0.46)} />
    </div>
  );
}

export type { MobileLayoutType, MobileLayoutPosition };
