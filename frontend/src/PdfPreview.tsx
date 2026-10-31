import { useEffect, useRef, useState, useCallback } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type {
  DrawingPage,
  EvidenceSelection,
  ValidationOverlay,
  VisualObject,
  VisualObjectType,
} from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

type PdfPreviewProps = {
  file: File;
  pages: DrawingPage[];
  currentPage: number;
  selection: EvidenceSelection | null;
  validationSelection: ValidationOverlay[];
  visualObjects: VisualObject[];
  visualSelection: VisualObject | null;
  visibleVisualTypes: Set<VisualObjectType>;
  extractedRegions: EvidenceSelection[];
  showExtractedRegions: boolean;
  onShowExtractedRegions: (show: boolean) => void;
  onPageChange: (page: number) => void;
  onClearSelection: () => void;
};

export default function PdfPreview({
  file,
  pages,
  currentPage,
  selection,
  validationSelection,
  visualObjects,
  visualSelection,
  visibleVisualTypes,
  extractedRegions,
  showExtractedRegions,
  onShowExtractedRegions,
  onPageChange,
  onClearSelection,
}: PdfPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapWrapRef = useRef<HTMLDivElement>(null);

  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [hostWidth, setHostWidth] = useState(720);
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dynamic preview (minimap) state
  const [showDynamicPreview, setShowDynamicPreview] = useState(true);
  const [minimapSize, setMinimapSize] = useState({ width: 175, height: 120 });
  const [viewportRatio, setViewportRatio] = useState({ x: 0, y: 0, w: 100, h: 100 });
  const [isMinimapDragging, setIsMinimapDragging] = useState(false);

  // Easy moving (click-and-drag panning) state
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      setHostWidth(Math.max(320, entry.contentRect.width - 48));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    const url = URL.createObjectURL(file);
    const task = getDocument({ url });
    task.promise
      .then((loaded) => {
        if (!disposed) setDocument(loaded);
      })
      .catch(() => {
        if (!disposed) setError("The PDF preview could not be rendered.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      void task.destroy();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Main high-res canvas rendering
  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let disposed = false;
    let renderTask: RenderTask | null = null;
    document
      .getPage(currentPage)
      .then((page) => {
        if (disposed || !canvasRef.current) return;
        const natural = page.getViewport({ scale: 1 });
        const fitScale = hostWidth / natural.width;
        const viewport = page.getViewport({ scale: fitScale * zoom });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable");
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setRenderSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        return renderTask.promise;
      })
      .catch((caught) => {
        if (!disposed && caught instanceof Error && caught.name !== "RenderingCancelledException") {
          setError("The selected page could not be rendered.");
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [currentPage, document, hostWidth, zoom]);

  // Dynamic preview minimap rendering
  useEffect(() => {
    if (!document || !minimapCanvasRef.current) return;
    let disposed = false;
    let renderTask: RenderTask | null = null;
    document
      .getPage(currentPage)
      .then((page) => {
        if (disposed || !minimapCanvasRef.current) return;
        const natural = page.getViewport({ scale: 1 });
        const targetWidth = 175;
        const thumbScale = targetWidth / natural.width;
        const viewport = page.getViewport({ scale: thumbScale });
        const canvas = minimapCanvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setMinimapSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        return renderTask.promise;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [currentPage, document]);

  // Synchronize viewport indicator with scroll position and size
  const updateViewportRatio = useCallback(() => {
    const host = hostRef.current;
    if (!host || !renderSize.width || !renderSize.height) return;
    const w = Math.min(100, Math.max(4, (host.clientWidth / renderSize.width) * 100));
    const h = Math.min(100, Math.max(4, (host.clientHeight / renderSize.height) * 100));
    const x = Math.min(100 - w, Math.max(0, (host.scrollLeft / renderSize.width) * 100));
    const y = Math.min(100 - h, Math.max(0, (host.scrollTop / renderSize.height) * 100));
    setViewportRatio({ x, y, w, h });
  }, [renderSize]);

  useEffect(() => {
    updateViewportRatio();
  }, [updateViewportRatio, renderSize]);

  const pageMetadata = pages.find((page) => page.page_number === currentPage);

  // Auto-center viewport when evidence is selected
  useEffect(() => {
    if (
      !selection ||
      selection.pageNumber !== currentPage ||
      !hostRef.current ||
      !pageMetadata?.width ||
      !pageMetadata.height ||
      !renderSize.width ||
      !renderSize.height
    )
      return;

    const [x0, y0, x1, y1] = selection.boundingBox;
    const centerX = (((x0 + x1) / 2) / pageMetadata.width) * renderSize.width;
    const centerY = (((y0 + y1) / 2) / pageMetadata.height) * renderSize.height;

    hostRef.current.scrollTo({
      left: Math.max(0, centerX - hostRef.current.clientWidth / 2),
      top: Math.max(0, centerY - hostRef.current.clientHeight / 2),
      behavior: "smooth",
    });
  }, [selection, currentPage, renderSize, pageMetadata]);

  // Dynamic preview interaction: move main view from minimap
  const moveMainFromMinimap = (clientX: number, clientY: number) => {
    const wrap = minimapWrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host || !renderSize.width || !renderSize.height) return;
    const rect = wrap.getBoundingClientRect();
    const ratioX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ratioY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    host.scrollLeft = ratioX * renderSize.width - host.clientWidth / 2;
    host.scrollTop = ratioY * renderSize.height - host.clientHeight / 2;
    updateViewportRatio();
  };

  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsMinimapDragging(true);
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    moveMainFromMinimap(e.clientX, e.clientY);
  };

  const handleMinimapPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMinimapDragging) return;
    moveMainFromMinimap(e.clientX, e.clientY);
  };

  const handleMinimapPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsMinimapDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Easy moving: click-and-drag panning on the main viewport
  const handleViewportMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest(".dynamic-preview-panel")) return;
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: hostRef.current?.scrollLeft || 0,
      scrollTop: hostRef.current?.scrollTop || 0,
    };
  };

  const handleViewportMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanning || !panStartRef.current || !hostRef.current) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    hostRef.current.scrollLeft = panStartRef.current.scrollLeft - dx;
    hostRef.current.scrollTop = panStartRef.current.scrollTop - dy;
  };

  const handleViewportMouseUp = () => {
    setIsPanning(false);
    panStartRef.current = null;
  };

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Active non-passive event listeners to ensure two-finger gestures zoom only the drawing
  // and prevent browser whole-page zoom (trackpad pinch wheel + touch pinch).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onWheelNative = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.005);
        setZoom((z) => Math.min(3.0, Math.max(0.5, Number((z * factor).toFixed(2)))));
      }
    };

    let initialPinchDistance = 0;
    let pinchStartZoom = 1;
    let singleTouchStart: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.hypot(dx, dy);
        pinchStartZoom = zoomRef.current;
        singleTouchStart = null;
      } else if (e.touches.length === 1) {
        singleTouchStart = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          scrollLeft: host.scrollLeft,
          scrollTop: host.scrollTop,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && initialPinchDistance > 0) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDist = Math.hypot(dx, dy);
        const scale = currentDist / initialPinchDistance;
        setZoom(Math.min(3.0, Math.max(0.5, Number((pinchStartZoom * scale).toFixed(2)))));
      } else if (e.touches.length === 1 && singleTouchStart) {
        e.preventDefault();
        const dx = e.touches[0].clientX - singleTouchStart.x;
        const dy = e.touches[0].clientY - singleTouchStart.y;
        host.scrollLeft = singleTouchStart.scrollLeft - dx;
        host.scrollTop = singleTouchStart.scrollTop - dy;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        initialPinchDistance = 0;
      }
      if (e.touches.length === 0) {
        singleTouchStart = null;
      }
    };

    host.addEventListener("wheel", onWheelNative, { passive: false });
    host.addEventListener("touchstart", onTouchStart, { passive: false });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: false });
    host.addEventListener("touchcancel", onTouchEnd, { passive: false });

    return () => {
      host.removeEventListener("wheel", onWheelNative);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const highlight =
    selection &&
    selection.pageNumber === currentPage &&
    pageMetadata?.width &&
    pageMetadata.height
      ? {
          left: `${(selection.boundingBox[0] / pageMetadata.width) * 100}%`,
          top: `${(selection.boundingBox[1] / pageMetadata.height) * 100}%`,
          width: `${
            ((selection.boundingBox[2] - selection.boundingBox[0]) / pageMetadata.width) * 100
          }%`,
          height: `${
            ((selection.boundingBox[3] - selection.boundingBox[1]) / pageMetadata.height) * 100
          }%`,
        }
      : null;

  const visibleRegions = showExtractedRegions && pageMetadata?.width && pageMetadata.height
    ? extractedRegions
        .filter((region) => region.pageNumber === currentPage)
        .map((region) => ({
          region,
          style: {
            left: `${(region.boundingBox[0] / pageMetadata.width!) * 100}%`,
            top: `${(region.boundingBox[1] / pageMetadata.height!) * 100}%`,
            width: `${((region.boundingBox[2] - region.boundingBox[0]) / pageMetadata.width!) * 100}%`,
            height: `${((region.boundingBox[3] - region.boundingBox[1]) / pageMetadata.height!) * 100}%`,
          },
        }))
    : [];

  const validationRegions = pageMetadata?.width && pageMetadata.height
    ? validationSelection
        .filter((region) => region.pageNumber === currentPage)
        .map((region) => ({
          region,
          style: {
            left: `${(region.boundingBox[0] / pageMetadata.width!) * 100}%`,
            top: `${(region.boundingBox[1] / pageMetadata.height!) * 100}%`,
            width: `${((region.boundingBox[2] - region.boundingBox[0]) / pageMetadata.width!) * 100}%`,
            height: `${((region.boundingBox[3] - region.boundingBox[1]) / pageMetadata.height!) * 100}%`,
          },
        }))
    : [];

  const visualRegions = pageMetadata?.width && pageMetadata.height
    ? visualObjects
        .filter(
          (region) =>
            region.page_number === currentPage && visibleVisualTypes.has(region.object_type),
        )
        .map((region) => ({
          region,
          style: {
            left: `${(region.bounding_box[0] / pageMetadata.width!) * 100}%`,
            top: `${(region.bounding_box[1] / pageMetadata.height!) * 100}%`,
            width: `${((region.bounding_box[2] - region.bounding_box[0]) / pageMetadata.width!) * 100}%`,
            height: `${((region.bounding_box[3] - region.bounding_box[1]) / pageMetadata.height!) * 100}%`,
          },
        }))
    : [];

  const totalPages = document?.numPages ?? pages.length ?? 1;

  return (
    <section className="preview" aria-label="PDF drawing preview">
      <div className="preview__toolbar">
        <div className="page-controls" aria-label="Page controls">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            ←
          </button>
          <span>
            Sheet <strong>{currentPage}</strong> / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            →
          </button>
        </div>
        <div className="zoom-controls" aria-label="Zoom controls">
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.2).toFixed(2))))}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <span title="Current zoom">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(3.0, Number((value + 0.2).toFixed(2))))}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="zoom-preset-btn"
            onClick={() => setZoom(1.0)}
            title="Reset to 100% Fit"
          >
            Fit
          </button>
          <button
            type="button"
            className={`minimap-toggle-btn ${showDynamicPreview ? "minimap-toggle-btn--active" : ""}`}
            onClick={() => setShowDynamicPreview((prev) => !prev)}
            title={showDynamicPreview ? "Hide Dynamic Preview" : "Show Dynamic Preview"}
            aria-label="Toggle Dynamic Preview"
          >
            ⊞ Preview
          </button>
        </div>
      </div>

      {visualSelection ? (
        <div className="evidence-banner evidence-banner--visual">
          <span className="evidence-banner__pulse" />
          <span className="evidence-banner__copy">
            Showing visual object <strong>{visualSelection.object_type.replaceAll("_", " ")}</strong>
            <small>
              {Math.round(visualSelection.confidence * 100)}% · {visualSelection.detector.replaceAll("_", " ")}
              {visualSelection.raw_text ? ` · Detected: ${visualSelection.raw_text}` : ""}
            </small>
          </span>
          <button type="button" onClick={onClearSelection}>Clear</button>
        </div>
      ) : validationSelection.length ? (
        <div className="evidence-banner evidence-banner--validation">
          <span className="evidence-banner__pulse" />
          <span className="evidence-banner__copy">
            Showing {validationSelection.length} evidence region{validationSelection.length === 1 ? "" : "s"} for <strong>{validationSelection[0].label}</strong>
            <small>
              {validationSelection[0].status.replaceAll("_", " ")} · {Math.round(validationSelection[0].confidence * 100)}% evidence confidence
              {validationSelection[0].method ? ` · ${validationSelection[0].method.replaceAll("_", " ")}` : ""}
              {validationSelection[0].rawText ? ` · Raw: ${validationSelection[0].rawText}` : ""}
            </small>
          </span>
          <button type="button" onClick={onClearSelection}>Clear</button>
        </div>
      ) : selection ? (
        <div className="evidence-banner">
          <span className="evidence-banner__pulse" />
          <span className="evidence-banner__copy">
            Showing source for <strong>{selection.label}</strong>
            <small>
              {selection.field.confidence_category} · {Math.round(selection.field.confidence * 100)}% · {selection.field.extraction_method?.replaceAll("_", " ")}
              {selection.field.evidence_anchor ? ` · ${selection.field.evidence_anchor}` : ""}
              {selection.field.raw_text ? ` · Raw: ${selection.field.raw_text}` : ""}
            </small>
          </span>
          <button type="button" onClick={onClearSelection}>Clear</button>
        </div>
      ) : (
        <div className="evidence-hint">Select an evidenced field to locate it on the drawing. Drag to pan anywhere.</div>
      )}

      <div
        className={`preview__viewport ${isPanning ? "is-panning" : "can-pan"}`}
        ref={hostRef}
        onScroll={updateViewportRatio}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
      >
        {error && <div className="preview-state preview-state--error">{error}</div>}
        {loading && !error && <div className="preview-state"><span className="loader" />Rendering sheet</div>}
        <div
          className="pdf-page"
          style={{ width: renderSize.width, height: renderSize.height }}
        >
          <canvas ref={canvasRef} />
          {visibleRegions.map(({ region, style }, index) => (
            <div
              className="extracted-region"
              style={style}
              key={`${region.pageNumber}-${region.boundingBox.join("-")}-${index}`}
              aria-hidden="true"
            />
          ))}
          {validationRegions.map(({ region, style }, index) => (
            <div
              className={`validation-highlight validation-highlight--${region.status.toLowerCase()}`}
              style={style}
              key={`validation-${region.pageNumber}-${region.boundingBox.join("-")}-${index}`}
              role="img"
              aria-label={`${region.status.replaceAll("_", " ")} evidence: ${region.label}`}
            >
              <span>{region.status.replaceAll("_", " ")} · {region.label}</span>
            </div>
          ))}
          {visualRegions.map(({ region, style }) => (
            <div
              className={`visual-highlight visual-highlight--${region.object_type.toLowerCase()} ${visualSelection?.object_id === region.object_id ? "visual-highlight--selected" : ""}`}
              style={style}
              key={`visual-${region.object_id}`}
              role="img"
              aria-label={`${region.object_type.replaceAll("_", " ")} visual evidence`}
            >
              <span>{region.normalized_text ? `${region.normalized_text} · ` : ""}{region.object_type.replaceAll("_", " ")} · {Math.round(region.confidence * 100)}%</span>
            </div>
          ))}
          {highlight && (
            <div className="source-highlight" style={highlight} aria-label={selection?.label}>
              <span>{selection?.label}</span>
            </div>
          )}
        </div>

        {/* Dynamic Preview Minimap Navigator */}
        {showDynamicPreview && (
          <div className="dynamic-preview-panel" aria-label="Dynamic Preview Navigator">
            <div className="dynamic-preview-panel__header">
              <span className="dynamic-preview-panel__title">
                <span className="dynamic-preview-panel__dot" /> Dynamic Preview
              </span>
              <span className="dynamic-preview-panel__scale">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="dynamic-preview-panel__close"
                onClick={() => setShowDynamicPreview(false)}
                title="Hide dynamic preview"
                aria-label="Hide dynamic preview"
              >
                ✕
              </button>
            </div>
            <div
              className="dynamic-preview-panel__canvas-wrap"
              ref={minimapWrapRef}
              onPointerDown={handleMinimapPointerDown}
              onPointerMove={handleMinimapPointerMove}
              onPointerUp={handleMinimapPointerUp}
              style={{ width: minimapSize.width, height: minimapSize.height }}
              title="Click or drag to move visible region"
            >
              <canvas ref={minimapCanvasRef} />
              {/* Evidence marker on dynamic preview */}
              {highlight && (
                <div
                  className="dynamic-preview__marker"
                  style={{
                    left: highlight.left,
                    top: highlight.top,
                    width: highlight.width,
                    height: highlight.height,
                  }}
                />
              )}
              {/* Live viewfinder rectangle */}
              <div
                className="dynamic-preview__viewfinder"
                style={{
                  left: `${viewportRatio.x}%`,
                  top: `${viewportRatio.y}%`,
                  width: `${viewportRatio.w}%`,
                  height: `${viewportRatio.h}%`,
                }}
              />
            </div>
            <div className="dynamic-preview-panel__footer">
              <span>Drag to move · Click to jump</span>
            </div>
          </div>
        )}
      </div>

      <div className="preview__status">
        <span className={pageMetadata?.native_text_available ? "status-dot" : "status-dot status-dot--muted"} />
        {pageMetadata?.native_text_available ? "Native text available" : "No native text detected"}
        <span className="preview__status-separator" />
        <label className="region-toggle">
          <input
            type="checkbox"
            checked={showExtractedRegions}
            onChange={(event) => onShowExtractedRegions(event.target.checked)}
          />
          Show Extracted Regions
        </label>
        <span className="preview__status-separator" />
        {pageMetadata?.word_count ?? 0} words · {pageMetadata?.text_block_count ?? 0} blocks
      </div>
    </section>
  );
}
