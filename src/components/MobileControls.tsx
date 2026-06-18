// MobileControls.tsx

import { useRef, useCallback, useEffect, useState } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onJoystick: (x: number, y: number) => void;
  onJump: () => void;
  onLook: (dx: number) => void;
  disabled: boolean;
}

export default function MobileControls({ onJoystick, onJump, onLook, disabled }: Props) {
  const { language } = useSettings();
  const lang = language;
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLDivElement | null>(null);
  const joyTouchId = useRef<number | null>(null);
  const joyStart = useRef({ x: 0, y: 0 });
  const lookTouchId = useRef<number | null>(null);
  const lastLookX = useRef(0);
  const [stickPos, setStickPos] = useState({ x: 0, y: 0 });
  const [stickVis, setStickVis] = useState(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return;
    const w = window.innerWidth;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const target = touch.target as HTMLElement | null;

      if (target && (
        target.classList.contains('jump-btn') || target.closest('.jump-btn') ||
        target.classList.contains('pause-btn') || target.closest('.pause-btn') ||
        target.classList.contains('spectate-switch-btn') || target.closest('.spectate-switch-btn')
      )) {
        continue;
      }

      if (touch.clientX < w * 0.45) {
        // Always re-claim the joystick on any left-zone touchstart.
        // Android can reassign touch.identifier mid-gesture (palm rejection,
        // screen protectors, etc.) which would orphan joyTouchId and cause
        // all subsequent touchmove events to be ignored.
        joyTouchId.current = touch.identifier;
        joyStart.current = { x: touch.clientX, y: touch.clientY };
        setStickVis(true);
        if (baseRef.current) {
          baseRef.current.style.left = `${touch.clientX}px`;
          baseRef.current.style.top = `${touch.clientY}px`;
        }
        e.preventDefault();
        continue;
      }

      if (touch.clientX >= w * 0.45 && lookTouchId.current === null) {
        lookTouchId.current = touch.identifier;
        lastLookX.current = touch.clientX;
        e.preventDefault();
      }
    }
  }, [disabled]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    console.log('touchmove', 'disabled=', disabled, 'joyId=', joyTouchId.current);
    if (disabled) return;
    // Prevent scroll rubber-banding and zoom during any active touch
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === joyTouchId.current) {
        const dx = (touch.clientX - joyStart.current.x) / 50;
        const dy = (touch.clientY - joyStart.current.y) / 50;
        const cx = Math.max(-1, Math.min(1, dx));
        const cy = Math.max(-1, Math.min(1, dy));
        onJoystick(cx, cy);
        setStickPos({ x: cx * 30, y: cy * 30 });
      } else if (touch.identifier === lookTouchId.current) {
        const dx = touch.clientX - lastLookX.current;
        lastLookX.current = touch.clientX;
        onLook(dx * 0.006);
      }
    }
  }, [disabled, onJoystick, onLook]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === joyTouchId.current) {
        joyTouchId.current = null;
        onJoystick(0, 0);
        setStickPos({ x: 0, y: 0 });
        setStickVis(false);
      } else if (touch.identifier === lookTouchId.current) {
        lookTouchId.current = null;
      }
    }
  }, [onJoystick]);

  const handleTouchCancel = useCallback((e: TouchEvent) => {
    handleTouchEnd(e);
  }, [handleTouchEnd]);

  useEffect(() => {
    const opts: AddEventListenerOptions = { passive: false, capture: true };
    document.body.addEventListener('touchstart', handleTouchStart, opts);
    document.body.addEventListener('touchmove', handleTouchMove, opts);
    document.body.addEventListener('touchend', handleTouchEnd, opts);
    document.body.addEventListener('touchcancel', handleTouchCancel, opts);
    return () => {
      document.body.removeEventListener('touchstart', handleTouchStart, opts);
      document.body.removeEventListener('touchmove', handleTouchMove, opts);
      document.body.removeEventListener('touchend', handleTouchEnd, opts);
      document.body.removeEventListener('touchcancel', handleTouchCancel, opts);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel]);

  return (
    <div
      className="mobile-controls"
      style={{ pointerEvents: disabled ? 'none' : 'auto', opacity: disabled ? 0.3 : 1 }}
    >
      <div
        ref={baseRef}
        className="joystick floating"
        style={{
          opacity: stickVis ? 1 : 0,
          transform: 'translate(-50%, -50%)',
          left: 0,
          top: 0,
        }}
      >
        <div
          ref={innerRef}
          className="joystick-inner"
          style={{ transform: `translate(calc(-50% + ${stickPos.x}px), calc(-50% + ${stickPos.y}px))` }}
        />
      </div>
      <div ref={joystickRef} style={{ display: 'none' }} />
      <button
        className="jump-btn"
        onTouchStart={(e) => {
          e.stopPropagation();
          e.preventDefault(); // ← kills the 300 ms synthetic click on Android
          if (!disabled) onJump();
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {t('jump', lang)}
      </button>
    </div>
  );
}