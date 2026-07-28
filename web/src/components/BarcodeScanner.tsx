import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { useI18n } from "./I18n";

type BarcodeDetectorResult = { rawValue: string };
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>;
};
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code", "data_matrix"];

export function ScanButton({ onScan, title }: {
  onScan: (text: string) => void;
  title?: string;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return <>
    <button type="button" className="btn btn-sm" title={title ?? t("Scan")} onClick={() => setOpen(true)}>
      <span aria-hidden="true">▮▯▮</span> {t("Scan")}
    </button>
    {open && <BarcodeScanner onScan={onScan} onClose={() => setOpen(false)} hint={title} />}
  </>;
}

export function BarcodeScanner({
  onScan,
  onClose,
  hint,
}: {
  onScan: (text: string) => void;
  onClose: () => void;
  hint?: string;
}): JSX.Element {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingRef = useRef<boolean>(false);
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  const stopRef = useRef<() => void>(() => {});
  const bodyScrollLockRef = useRef(false);
  const [error, setError] = useState("");

  onScanRef.current = onScan;
  onCloseRef.current = onClose;

  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;
    let animationFrame = 0;
    let zxingControls: { stop(): void } | null = null;

    if (!document.body.classList.contains("scanner-open")) {
      document.body.classList.add("scanner-open");
      bodyScrollLockRef.current = true;
    }

    const stop = () => {
      active = false;
      cancelAnimationFrame(animationFrame);
      zxingControls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      const previewStream = videoRef.current?.srcObject;
      if (previewStream instanceof MediaStream && previewStream !== stream) {
        previewStream.getTracks().forEach((track) => track.stop());
      }
    };
    stopRef.current = stop;

    const accept = (rawValue: string) => {
      const value = rawValue.trim();
      if (!value || processingRef.current) return;
      processingRef.current = true;
      stop();
      onScanRef.current(value);
      onCloseRef.current();
    };

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(t("Camera scanning needs a secure connection (HTTPS or localhost). You can still type the code manually."));
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
        if (Detector) {
          let formats = FORMATS;
          if (Detector.getSupportedFormats) {
            const supported = await Detector.getSupportedFormats();
            formats = FORMATS.filter((format) => supported.includes(format));
          }
          const detector = new Detector(formats.length ? { formats } : undefined);
          let lastDetection = 0;
          const detect = (now: number) => {
            if (!active) return;
            if (now - lastDetection >= 200 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              lastDetection = now;
              void detector.detect(video)
                .then((barcodes) => {
                  if (active && barcodes[0]) accept(barcodes[0].rawValue);
                })
                .catch((cause: unknown) => {
                  if (active) setError(cause instanceof Error ? cause.message : String(cause));
                });
            }
            animationFrame = requestAnimationFrame(detect);
          };
          animationFrame = requestAnimationFrame(detect);
          return;
        }

        // The ZXing fallback manages its own camera stream.
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
          if (result) accept(result.getText());
        });
        if (!active) controls.stop();
        else zxingControls = controls;
      } catch (cause) {
        if (!active) return;
        const cameraError = cause instanceof Error ? cause : new Error(String(cause));
        if (cameraError.name === "NotAllowedError" || cameraError.name === "SecurityError") {
          setError(t("Camera permission required to scan. Please enable camera access in your browser settings."));
        } else {
          setError(cameraError.message);
        }
      }
    };

    void start();
    return () => {
      stop();
      stopRef.current = () => {};
      if (bodyScrollLockRef.current) {
        document.body.classList.remove("scanner-open");
        bodyScrollLockRef.current = false;
      }
    };
  }, [t]);

  const close = () => {
    stopRef.current();
    onClose();
  };

  return <div className="scanner-overlay" role="dialog" aria-modal="true" aria-label={t("Camera")}>
    <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
    <div className="scanner-guide" aria-hidden="true" />
    {hint && <div className="scanner-hint">{hint}</div>}
    {error && <div className="scanner-error">{error}</div>}
    <button type="button" className="scanner-close-btn" onClick={close}>{t("Cancel")}</button>
  </div>;
}
