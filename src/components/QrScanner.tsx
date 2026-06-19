import { useEffect, useRef, useState, useCallback } from 'react';
import jsQR from 'jsqr';

interface Props {
  /** Called when a QR code is successfully decoded. The component will stop
   *  scanning after the first successful decode. */
  onDecode: (text: string) => void;
  /** Called when the user clicks the close button or when scanning fails
   *  irrecoverably (e.g. camera permission denied). */
  onClose: () => void;
  /** Optional title shown above the camera view. */
  title?: string;
}

/**
 * Live camera QR code scanner.
 *
 * Uses the device's rear camera via `getUserMedia` and decodes QR codes with
 * the `jsqr` library (pure JS, no native dependencies). Scans the video feed
 * at ~10 fps; on the first successful decode, calls `onDecode` and closes.
 *
 * Mobile-friendly:
 *  - Requests the rear camera (`facingMode: 'environment'`) so the user
 *    doesn't have to flip the phone.
 *  - Renders the video element full-screen so it's easy to aim at a QR.
 *  - Handles the common error cases (permission denied, no camera, insecure
 *    context) with clear messages.
 *  - **Flashlight/torch toggle**: if the device supports torch (most phones
 *    do, desktops usually don't), a 🔦 button appears in the bottom bar so
 *    the user can turn the LED flash on/off for scanning in low light.
 *
 * Security/privacy:
 *  - Camera access requires HTTPS (or localhost). On http:// the browser
 *    blocks getUserMedia — we surface a clear error.
 *  - The video frame is decoded locally; nothing is uploaded.
 */
export default function QrScanner({ onDecode, onClose, title = 'Scan QR Code' }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decodedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** Whether the device's camera track supports torch (LED flash). */
  const [torchSupported, setTorchSupported] = useState(false);
  /** Whether the torch is currently on. */
  const [torchOn, setTorchOn] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      streamRef.current = null;
    }
  }, []);

  /**
   * Toggle the device's LED flash (torch) on/off. Uses the MediaStreamTrack
   * `torch` constraint via `applyConstraints`. Not all devices support this —
   * we detect support via `getCapabilities()` after the camera starts and only
   * show the torch button if supported.
   *
   * Common support:
   *  - Android Chrome: ✓ (most phones with rear LED flash)
   *  - iOS Safari: ✗ (Apple doesn't expose torch to web pages as of iOS 17)
   *  - Desktop: ✗ (no LED flash hardware)
   */
  const toggleTorch = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
      if (!caps?.torch) {
        console.warn('[QR Scanner] Torch not supported on this device.');
        return;
      }
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
      console.log('[QR Scanner] Torch:', next ? 'ON' : 'OFF');
    } catch (e) {
      console.warn('[QR Scanner] Failed to toggle torch:', e);
    }
  }, [torchOn]);

  // Start the camera + scan loop on mount; stop on unmount.
  useEffect(() => {
    let mounted = true;

    async function start() {
      // Feature detection — older Safari lacks mediaDevices.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('Camera not supported on this device/browser. You can still paste the code manually.');
        return;
      }
      // Insecure context (http://) blocks camera access.
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        setError('Camera requires HTTPS. Either open the game over https://, or paste the code manually.');
        return;
      }
      try {
        // Prefer the rear camera. `facingMode: 'environment'` works on most
        // mobile browsers; desktop browsers will fall back to whatever
        // camera they have.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!mounted) {
          // Component unmounted while we were waiting for permission —
          // immediately stop the stream we just got.
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;

        // Detect torch support. `getCapabilities()` is not available on all
        // browsers (e.g. older Safari), so guard with optional chaining.
        const track = stream.getVideoTracks()[0];
        try {
          const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean } | undefined;
          if (caps?.torch) {
            setTorchSupported(true);
            console.log('[QR Scanner] Torch is supported on this device.');
          } else {
            console.log('[QR Scanner] Torch not supported (desktop or iOS).');
          }
        } catch {
          // getCapabilities not available — torch not supported.
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // `playsInline` is critical on iOS — without it, the video opens in
        // fullscreen native player and our scan loop never runs.
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        await video.play();
        setReady(true);
        startScanLoop();
      } catch (e: any) {
        if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
          setError('Camera permission denied. Please allow camera access in your browser settings, or paste the code manually.');
        } else if (e?.name === 'NotFoundError' || e?.name === 'DevicesNotFoundError') {
          setError('No camera found on this device. Paste the code manually instead.');
        } else if (e?.name === 'NotReadableError') {
          setError('Camera is in use by another app. Close it and try again, or paste the code manually.');
        } else {
          setError(e?.message ?? 'Failed to access camera. Paste the code manually instead.');
        }
      }
    }

    function startScanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      let lastScan = 0;
      // ~10 fps scan rate — fast enough to catch a QR in real time, but
      // gentle on the battery/CPU. decodeImage is the expensive call.
      const SCAN_INTERVAL_MS = 100;

      const tick = () => {
        if (!mounted) return;
        if (decodedRef.current) return;
        const now = performance.now();
        if (now - lastScan < SCAN_INTERVAL_MS) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        lastScan = now;

        // Wait until the video has a measurable frame dimensions. Safari
        // fires `loadedmetadata` but videoWidth is still 0 for a few frames.
        if (video.readyState !== video.HAVE_ENOUGH_DATA || video.videoWidth === 0) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        // Draw the current video frame to the canvas at its native resolution
        // (downscaling would lose QR detail; upscaling would waste CPU).
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        try {
          ctx.drawImage(video, 0, 0, w, h);
        } catch {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        // Try to decode a QR from the frame. jsQR returns null if no QR is
        // found — that's the common case, we just try again next tick.
        try {
          const imageData = ctx.getImageData(0, 0, w, h);
          const code = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });
          if (code && code.data && !decodedRef.current) {
            decodedRef.current = true;
            console.log('[QR Scanner] Decoded:', code.data.slice(0, 60) + (code.data.length > 60 ? '…' : ''));
            // Turn off the torch before stopping (some devices keep the LED
            // on after the track is stopped if we don't explicitly disable it).
            const track = streamRef.current?.getVideoTracks()[0];
            if (track) {
              try { track.applyConstraints({ advanced: [{ torch: false } as any] }); } catch { /* ignore */ }
            }
            // Stop the camera BEFORE calling onDecode — onDecode will likely
            // unmount this component, and we want to release the camera
            // synchronously to avoid the "camera still on" race.
            stop();
            onDecode(code.data);
            return;
          }
        } catch {
          /* ignore — getImageData can throw on cross-origin video, but our
             video is from a local stream so this shouldn't happen. */
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }

    start();

    return () => {
      mounted = false;
      stop();
    };
  }, [onDecode, stop]);

  const handleClose = useCallback(() => {
    // Turn off the torch before closing (defensive — see comment in decode handler).
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      try { track.applyConstraints({ advanced: [{ torch: false } as any] }); } catch { /* ignore */ }
    }
    stop();
    onClose();
  }, [onClose, stop]);

  return (
    <div
      className="qr-scanner-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      {/* Top bar: title + close button */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '1rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)',
          color: '#fff',
          fontSize: '1rem',
          fontWeight: 600,
        }}
      >
        <span>📷 {title}</span>
        <button
          onClick={handleClose}
          aria-label="Close scanner"
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            color: '#fff',
            width: 36,
            height: 36,
            borderRadius: '50%',
            fontSize: '1.2rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>

      {/* Video element — fills the available space, object-fit: cover */}
      <video
        ref={videoRef}
        style={{
          width: '100%',
          maxWidth: '600px',
          maxHeight: '80vh',
          objectFit: 'cover',
          background: '#000',
          borderRadius: '12px',
          display: ready ? 'block' : 'none',
        }}
        playsInline
        muted
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Aim frame — shown when the camera is ready, helps the user aim */}
      {ready && !error && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(70vw, 320px)',
            height: 'min(70vw, 320px)',
            border: '3px solid rgba(255,255,255,0.9)',
            borderRadius: '16px',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }}
        >
          {/* Corner accents for a "scanner" look */}
          <span style={{ position: 'absolute', top: -3, left: -3, width: 24, height: 24, borderTop: '5px solid #4ade80', borderLeft: '5px solid #4ade80', borderTopLeftRadius: 12 }} />
          <span style={{ position: 'absolute', top: -3, right: -3, width: 24, height: 24, borderTop: '5px solid #4ade80', borderRight: '5px solid #4ade80', borderTopRightRadius: 12 }} />
          <span style={{ position: 'absolute', bottom: -3, left: -3, width: 24, height: 24, borderBottom: '5px solid #4ade80', borderLeft: '5px solid #4ade80', borderBottomLeftRadius: 12 }} />
          <span style={{ position: 'absolute', bottom: -3, right: -3, width: 24, height: 24, borderBottom: '5px solid #4ade80', borderRight: '5px solid #4ade80', borderBottomRightRadius: 12 }} />
        </div>
      )}

      {/* Loading spinner — shown until the camera is ready or errors out */}
      {!ready && !error && (
        <div style={{ color: '#fff', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span className="dot" style={{ animation: 'pulse 1s infinite', background: '#4ade80', width: 10, height: 10, borderRadius: '50%', display: 'inline-block' }} />
          Starting camera…
        </div>
      )}

      {/* Bottom bar: hint text + flashlight toggle */}
      {ready && !error && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '1rem 1rem max(1rem, env(safe-area-inset-bottom))',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.75rem',
            background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
          }}
        >
          <div style={{ color: '#fff', fontSize: '0.9rem', textAlign: 'center' }}>
            Point the camera at the QR code
          </div>
          {/* Flashlight / torch toggle — only shown if the device supports it.
              Most Android phones with a rear LED flash support this via
              MediaTrackConstraints.torch. iOS Safari does NOT expose torch
              (Apple limitation), so the button is hidden on iOS. Desktop
              browsers don't have a flash, so it's hidden there too. */}
          {torchSupported && (
            <button
              onClick={toggleTorch}
              aria-label={torchOn ? 'Turn off flashlight' : 'Turn on flashlight'}
              style={{
                background: torchOn ? 'rgba(250, 204, 21, 0.9)' : 'rgba(255,255,255,0.15)',
                border: 'none',
                color: torchOn ? '#000' : '#fff',
                width: 56,
                height: 56,
                borderRadius: '50%',
                fontSize: '1.5rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: torchOn ? '0 0 20px rgba(250, 204, 21, 0.6)' : 'none',
                transition: 'background 0.2s, box-shadow 0.2s',
                zIndex: 1001
              }}
            >
              🔦
            </button>
          )}
        </div>
      )}

      {/* Error message — shown when the camera can't be used */}
      {error && (
        <div
          style={{
            color: '#fca5a5',
            fontSize: '0.9rem',
            textAlign: 'center',
            maxWidth: '480px',
            padding: '1rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '8px',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ display: 'block', marginBottom: '0.4rem' }}>⚠️ Camera unavailable</strong>
          {error}
          <button
            className="ghost"
            onClick={handleClose}
            style={{ marginTop: '0.75rem', width: '100%' }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
