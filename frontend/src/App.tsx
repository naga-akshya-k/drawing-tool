import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import PdfPreview from "./PdfPreview";
import type {
  BOMItem,
  CompleteAnalysisReport,
  DrawingDocument,
  DrawingNote,
  DrawingUploadResponse,
  EvidenceSelection,
  ExtractedField,
  RelationshipReport,
  RelationshipResult,
  RevisionRecord,
  StandardReference,
  SupplierInfo,
  ValidationOverlay,
  ValidationReport,
  ValidationResult,
  ValidationRuleMetadata,
  ValidationStatus,
  VisionReport,
  VisualObject,
  VisualObjectType,
  VisualReviewAction,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type AnalysisTab =
  | "overview"
  | "revisions"
  | "notes"
  | "bom"
  | "supplier"
  | "standards"
  | "quality"
  | "validation"
  | "vision"
  | "relationships"
  | "report"
  | "json";

type NavigationGroup = "drawing" | "validation" | "visual" | "relationships" | "report";

const NAVIGATION: { id: NavigationGroup; label: string; tabs: { id: AnalysisTab; label: string }[] }[] = [
  {
    id: "drawing",
    label: "Drawing",
    tabs: [
      { id: "overview", label: "Overview" },
      { id: "revisions", label: "Revision" },
      { id: "notes", label: "Notes" },
      { id: "bom", label: "BOM / Parts" },
      { id: "supplier", label: "Supplier" },
      { id: "standards", label: "Standards" },
      { id: "quality", label: "Extraction Quality" },
      { id: "json", label: "Raw JSON" },
    ],
  },
  { id: "validation", label: "Validation", tabs: [{ id: "validation", label: "Checklist & Results" }] },
  { id: "visual", label: "Visual", tabs: [{ id: "vision", label: "Visual Intelligence" }] },
  { id: "relationships", label: "Relationships", tabs: [{ id: "relationships", label: "Relationship Intelligence" }] },
  { id: "report", label: "Report", tabs: [{ id: "report", label: "Final Engineering Review" }] },
];

const OVERVIEW_GROUPS: {
  title: string;
  fields: { key: keyof DrawingDocument; label: string }[];
}[] = [
  {
    title: "Drawing identity",
    fields: [
      { key: "drawing_number", label: "Drawing number" },
      { key: "revision", label: "Current revision" },
      { key: "part_name", label: "Part name" },
      { key: "document_type", label: "Document type" },
      { key: "source_filename", label: "File name" },
    ],
  },
  {
    title: "Drawing attributes",
    fields: [
      { key: "drawing_size", label: "Drawing size" },
      { key: "units", label: "Units" },
      { key: "scale", label: "Scale" },
      { key: "weight", label: "Weight" },
      { key: "page_count", label: "PDF pages" },
      { key: "sheet_number", label: "Sheet number" },
      { key: "total_sheets", label: "Total sheets" },
      { key: "critical_component", label: "Critical component" },
    ],
  },
  {
    title: "Release & ownership",
    fields: [
      { key: "release_date", label: "Release date" },
      { key: "drawing_date", label: "Drawing date" },
      { key: "drawn_by", label: "Drawn by" },
      { key: "modeled_by", label: "Modeled by" },
      { key: "approved_by", label: "Approved by" },
      { key: "part_numbers", label: "Part numbers" },
    ],
  },
];

function isExtractedField(value: unknown): value is ExtractedField {
  return Boolean(value && typeof value === "object" && "confidence" in value && "value" in value);
}

function collectLocatedFields(value: unknown, path = "drawing"): EvidenceSelection[] {
  if (isExtractedField(value)) {
    return value.bounding_box && value.page_number
      ? [{ label: path.split(".").at(-1)?.replaceAll("_", " ") ?? "Field", pageNumber: value.page_number, boundingBox: value.bounding_box, field: value }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectLocatedFields(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => collectLocatedFields(item, `${path}.${key}`));
  }
  return [];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not found";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return String(value).replaceAll("_", " ");
}

function formatMethod(method: ExtractedField["extraction_method"]): string {
  if (!method) return "No evidence";
  return method.replaceAll("_", " ");
}

function confidenceTone(confidence: number): string {
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.7) return "medium";
  return "low";
}

function Confidence({ field, compact = false }: { field: ExtractedField; compact?: boolean }) {
  const percent = Math.round(field.confidence * 100);
  return (
    <span className={`confidence confidence--${confidenceTone(field.confidence)} ${compact ? "confidence--compact" : ""}`}>
      <span className="confidence__dot" />
      {percent}%
    </span>
  );
}

function FieldButton({
  label,
  field,
  onSelect,
  className = "",
}: {
  label: string;
  field: ExtractedField;
  onSelect: (selection: EvidenceSelection) => void;
  className?: string;
}) {
  const canLocate = Boolean(field.bounding_box && field.page_number);
  return (
    <button
      type="button"
      className={`field ${field.value === null ? "field--empty" : ""} ${canLocate ? "field--locatable" : ""} ${className}`}
      disabled={!canLocate}
      onClick={() => {
        if (field.bounding_box && field.page_number) {
          onSelect({ label, pageNumber: field.page_number, boundingBox: field.bounding_box, field });
        }
      }}
      title={canLocate ? `Show ${label} on page ${field.page_number}` : "No source region available"}
    >
      <span className="field__label">{label}</span>
      <span className="field__value">{formatValue(field.value)}</span>
      <span className="field__meta">
        <Confidence field={field} compact />
        <span>{field.page_number ? `P${field.page_number}` : "—"}</span>
        {canLocate && <span className="locate-mark">⌖</span>}
      </span>
    </button>
  );
}

function EvidenceCell({
  label,
  field,
  onSelect,
}: {
  label: string;
  field: ExtractedField;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const canLocate = Boolean(field.bounding_box && field.page_number);
  return (
    <button
      type="button"
      className={`evidence-cell ${canLocate ? "evidence-cell--locatable" : ""}`}
      disabled={!canLocate}
      onClick={() => {
        if (field.bounding_box && field.page_number) {
          onSelect({ label, pageNumber: field.page_number, boundingBox: field.bounding_box, field });
        }
      }}
    >
      <span>{formatValue(field.value)}</span>
      <Confidence field={field} compact />
    </button>
  );
}

function SectionHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="section-header">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <p>{detail}</p>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      <span>∅</span>
      <p>{children}</p>
    </div>
  );
}

function UploadPage({
  file,
  isDragging,
  isUploading,
  error,
  onFile,
  onDragging,
  onUpload,
}: {
  file: File | null;
  isDragging: boolean;
  isUploading: boolean;
  error: string | null;
  onFile: (file?: File) => void;
  onDragging: (value: boolean) => void;
  onUpload: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    onDragging(false);
    onFile(event.dataTransfer.files[0]);
  }

  return (
    <main className="upload-page">
      <section className="upload-hero">
        <div className="upload-hero__copy">
          <span className="kicker"><span /> Level 1 – PDF Extraction</span>
          <h1>Engineering drawings,<br /><em>made legible.</em></h1>
          <p>
            Convert drawing PDFs into traceable structured data. Every extracted value
            remains connected to its page, source region, method, and confidence.
          </p>
          <div className="principles">
            <span>Native text first</span>
            <span>Spatial evidence</span>
            <span>No inferred values</span>
          </div>
        </div>

        <div className="upload-card">
          <div className="upload-card__header">
            <div>
              <span className="step-number">01</span>
              <h2>Upload drawing</h2>
            </div>
            <span className="pdf-chip">PDF · MAX 50 MB</span>
          </div>
          <div
            className={`dropzone ${isDragging ? "dropzone--active" : ""} ${file ? "dropzone--ready" : ""}`}
            onDragEnter={() => onDragging(true)}
            onDragLeave={() => onDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
            }}
            role="button"
            tabIndex={0}
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event: ChangeEvent<HTMLInputElement>) => onFile(event.target.files?.[0])}
            />
            <div className="file-glyph" aria-hidden="true"><span>PDF</span></div>
            {file ? (
              <>
                <strong>{file.name}</strong>
                <small>{(file.size / 1024 / 1024).toFixed(2)} MB · Ready for extraction</small>
                <span className="replace-file">Choose another file</span>
              </>
            ) : (
              <>
                <strong>Drop a drawing PDF here</strong>
                <small>or click to browse from your computer</small>
              </>
            )}
          </div>
          <button
            type="button"
            className="primary-action"
            disabled={!file || isUploading}
            onClick={onUpload}
          >
            {isUploading ? <span className="loader loader--dark" /> : <span>↗</span>}
            {isUploading ? "Extracting drawing data…" : "Analyze drawing"}
          </button>
          {error && <div className="alert" role="alert"><strong>Upload failed</strong>{error}</div>}
          <p className="privacy-note">Your file is stored under an opaque drawing ID for this PoC.</p>
        </div>
      </section>

      <section className="workflow-strip" aria-label="Extraction pipeline">
        {[
          ["01", "Inspect", "PDF structure"],
          ["02", "Extract", "Text + coordinates"],
          ["03", "Structure", "Level-1 JSON"],
        ].map(([number, title, detail]) => (
          <div key={number}>
            <span>{number}</span>
            <strong>{title}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </section>
    </main>
  );
}

function Overview({
  drawing,
  currentPage,
  onSelect,
}: {
  drawing: DrawingDocument;
  currentPage?: number;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const currentPageTitleBlock = drawing.pages?.find((p) => p.page_number === currentPage)?.title_block;

  return (
    <div className="tab-content">
      <SectionHeader
        eyebrow="Structured metadata"
        title="Drawing overview"
        detail="Values shown exactly as extracted from the source PDF."
      />
      {OVERVIEW_GROUPS.map((group) => (
        <section className="field-group" key={group.title}>
          <div className="field-group__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>{group.title}</h3>
            {group.title === "Drawing attributes" && currentPage && drawing.pages && drawing.pages.length > 1 && (
              <span style={{ fontSize: "9px", fontFamily: 'SFMono-Regular, Consolas, monospace', color: "var(--accent-deep)", background: "#eff7dd", padding: "2px 7px", borderRadius: "4px", fontWeight: 700 }}>
                Sheet {currentPage} of {drawing.pages.length}
              </span>
            )}
          </div>
          <div className="field-grid">
            {group.fields.map(({ key, label }) => {
              const pageField = currentPageTitleBlock && key in currentPageTitleBlock
                ? (currentPageTitleBlock as unknown as Record<string, unknown>)[key]
                : undefined;
              const field = isExtractedField(pageField) && pageField.value !== null
                ? pageField
                : drawing[key];
              return isExtractedField(field) ? (
                <FieldButton key={key} label={label} field={field} onSelect={onSelect} />
              ) : null;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Revisions({
  records,
  onSelect,
}: {
  records: RevisionRecord[];
  onSelect: (selection: EvidenceSelection) => void;
}) {
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Change history" title="Revision records" detail={`${records.length} explicit record${records.length === 1 ? "" : "s"} found.`} />
      {records.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>ECN</th><th>Description of change</th><th>Date</th><th>Changed by</th><th>Approved by</th><th>Page</th></tr></thead>
            <tbody>
              {records.map((record, index) => (
                <tr key={`${record.page_number}-${index}`}>
                  <td><EvidenceCell label="ECN" field={record.ecn} onSelect={onSelect} /></td>
                  <td className="data-table__description"><EvidenceCell label="Revision description" field={record.revision_description} onSelect={onSelect} /></td>
                  <td><EvidenceCell label="Revision date" field={record.revision_date} onSelect={onSelect} /></td>
                  <td><EvidenceCell label="Changed by" field={record.changed_by} onSelect={onSelect} /></td>
                  <td><EvidenceCell label="Approved by" field={record.approved_by} onSelect={onSelect} /></td>
                  <td><span className="page-tag">P{record.page_number ?? "—"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState>No revision records were explicitly found.</EmptyState>}
    </div>
  );
}

function Notes({ notes, onSelect }: { notes: DrawingNote[]; onSelect: (selection: EvidenceSelection) => void }) {
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Drawing instructions" title="Notes" detail={`${notes.length} numbered note${notes.length === 1 ? "" : "s"} preserved in source wording.`} />
      {notes.length ? (
        <div className="notes-list">
          {notes.map((note, index) => (
            <article className="note" key={`${note.page_number}-${note.number.value}-${index}`}>
              <div className="note__number">{note.number.value ?? index + 1}</div>
              <div className="note__body">
                <button
                  type="button"
                  className={note.text.bounding_box ? "note__text note__text--locatable" : "note__text"}
                  disabled={!note.text.bounding_box || !note.text.page_number}
                  onClick={() => {
                    if (note.text.bounding_box && note.text.page_number) {
                      onSelect({ label: `Note ${note.number.value ?? index + 1}`, pageNumber: note.text.page_number, boundingBox: note.text.bounding_box, field: note.text });
                    }
                  }}
                >
                  {note.text.value ?? "Not found"}
                </button>
                <div className="note__meta">
                  <Confidence field={note.text} compact />
                  <span>Page {note.page_number ?? "—"}</span>
                  <span>{formatMethod(note.text.extraction_method)}</span>
                  {note.standards?.map((standard) => <span className="standard-tag" key={standard.designation.value}>{standard.designation.value}</span>)}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : <EmptyState>No numbered notes were explicitly found.</EmptyState>}
    </div>
  );
}

function PartsTable({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: BOMItem[];
  onSelect: (selection: EvidenceSelection) => void;
}) {
  return (
    <section className="parts-section">
      <h3>{title} <span>{items.length}</span></h3>
      {items.length ? (
        <div className="data-table-wrap">
          <table className="data-table data-table--bom">
            <thead><tr><th>Item</th><th>Qty</th><th>Part number</th><th>Description</th><th>Page</th></tr></thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.page_number}-${item.part_number.value}-${index}`}>
                  <td><EvidenceCell label="BOM item" field={item.item_no} onSelect={onSelect} /></td>
                  <td><EvidenceCell label="BOM quantity" field={item.quantity} onSelect={onSelect} /></td>
                  <td><EvidenceCell label="BOM part number" field={item.part_number} onSelect={onSelect} /></td>
                  <td className="data-table__description"><EvidenceCell label="BOM description" field={item.description} onSelect={onSelect} /></td>
                  <td><span className="page-tag">P{item.page_number ?? "—"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="inline-empty">No {title.toLowerCase()} table was explicitly found.</p>}
    </section>
  );
}

function BomParts({
  drawing,
  onSelect,
}: {
  drawing: DrawingDocument;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  return (
    <div className="tab-content">
      <SectionHeader
        eyebrow="Structured tables"
        title="BOM / Parts"
        detail="Table families remain separate; absent cells are never inferred."
      />
      <PartsTable title="BOM" items={drawing.bom_items ?? []} onSelect={onSelect} />
      <PartsTable title="Part List" items={drawing.part_list_items ?? []} onSelect={onSelect} />
      <PartsTable title="Service Parts" items={drawing.service_part_items ?? []} onSelect={onSelect} />
    </div>
  );
}

function Supplier({
  supplier,
  rasterCount,
  onSelect,
}: {
  supplier: SupplierInfo | null;
  rasterCount: number;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  if (!supplier) return <div className="tab-content"><EmptyState>No explicit supplier metadata was found.</EmptyState></div>;
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Supplier wrapper evidence" title="Supplier information" detail="Metadata is extracted from explicit wrapper text only." />
      <div className="field-grid">
        <FieldButton label="Supplier drawing" field={supplier.supplier_drawing} onSelect={onSelect} />
        <FieldButton label="Supplier name" field={supplier.supplier_name} onSelect={onSelect} />
        <FieldButton label="Supplier part number" field={supplier.supplier_part_number} onSelect={onSelect} />
        <FieldButton label="Manufacturer" field={supplier.manufacturer_name} onSelect={onSelect} />
        <FieldButton label="Drawing marker" field={supplier.supplier_drawing_marker} onSelect={onSelect} />
        <FieldButton label="Imported CAD statement" field={supplier.imported_cad_data_statement} onSelect={onSelect} />
      </div>
      <section className="parts-section">
        <h3>Manufacturer part mappings <span>{supplier.manufacturer_part_number_mappings?.length ?? 0}</span></h3>
        {supplier.manufacturer_part_number_mappings?.length ? (
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Club Car part</th><th>Manufacturer part</th></tr></thead><tbody>
            {supplier.manufacturer_part_number_mappings.map((mapping, index) => <tr key={index}>
              <td><EvidenceCell label="Source part number" field={mapping.source_part_number} onSelect={onSelect} /></td>
              <td><EvidenceCell label="Manufacturer part number" field={mapping.manufacturer_part_number} onSelect={onSelect} /></td>
            </tr>)}
          </tbody></table></div>
        ) : <p className="inline-empty">No explicit manufacturer part-number mappings were found.</p>}
      </section>
      {rasterCount > 0 && <div className="raster-message"><strong>Supplier raster region detected</strong><span>{rasterCount} embedded supplier-original image region{rasterCount === 1 ? "" : "s"} detected. Internal raster content was not OCR-extracted in Level 1.</span></div>}
    </div>
  );
}

function ExtractionQuality({ drawing }: { drawing: DrawingDocument }) {
  const summary = drawing.level1_summary;
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Evidence quality" title="Extraction quality" detail="Confidence reflects observable extraction evidence, not engineering correctness." />
      <div className="quality-grid">
        {[
          ["Extracted fields", summary?.extracted_field_count ?? 0],
          ["High confidence", summary?.high_confidence_count ?? 0],
          ["Medium confidence", summary?.medium_confidence_count ?? 0],
          ["Low confidence", summary?.low_confidence_count ?? 0],
        ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <section className="parts-section">
        <h3>Extraction warnings <span>{drawing.extraction_warnings.length}</span></h3>
        {drawing.extraction_warnings.length ? <div className="warning-list">{drawing.extraction_warnings.map((warning, index) => <article key={`${warning.stage}-${index}`}>
          <span className={`warning-code warning-code--${warning.severity.toLowerCase()}`}>{warning.code ?? warning.severity}</span>
          <div><strong>{warning.stage.replaceAll("_", " ")}</strong><p>{warning.message}</p>{warning.page_number && <small>Page {warning.page_number}</small>}</div>
        </article>)}</div> : <p className="inline-empty">No extraction warnings were recorded.</p>}
      </section>
    </div>
  );
}

function Standards({
  standards,
  onSelect,
}: {
  standards: StandardReference[];
  onSelect: (selection: EvidenceSelection) => void;
}) {
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Referenced specifications" title="Engineering standards" detail="References are displayed without compliance interpretation." />
      {standards.length ? (
        <div className="standards-list">
          {standards.map((standard, index) => (
            <FieldButton
              key={`${standard.designation.value}-${index}`}
              label={`Reference ${String(index + 1).padStart(2, "0")}`}
              field={standard.designation}
              onSelect={onSelect}
              className="field--standard"
            />
          ))}
        </div>
      ) : <EmptyState>No referenced engineering standards were explicitly found.</EmptyState>}
    </div>
  );
}

type ValidationView =
  | "summary"
  | "checklist"
  | "failures"
  | "warnings"
  | "manual"
  | "not_evaluated"
  | "visual_upgrades"
  | "details";

type VisualUpgradeMetrics = {
  notEvaluatedBefore: number;
  unlockedRuleIds: string[];
  newPass: number;
  newFail: number;
  newWarning: number;
  remainingNotEvaluated: number;
};

const VISUAL_RULES_BY_TYPE: Partial<Record<VisualObjectType, string[]>> = {
  REVISION_TRIANGLE: ["REV-012"],
  BOM_BALLOON: ["BOM-011", "BOM-012", "XREF-007"],
  DATUM_SYMBOL: ["GDT-001", "GDT-002", "GDT-003"],
  GDT_FRAME: ["GDT-004", "GDT-005"],
  SCC_SYMBOL: ["BOM-014", "XREF-006"],
  FLAG_NOTE: ["NOTE-012"],
  SUPPLIER_RASTER_TEXT: ["SUP-010"],
  VIEW_ARROW: ["VIEW-001", "VIEW-002"],
  SECTION_ARROW: ["VIEW-003"],
  DETAIL_CALLOUT: ["VIEW-004"],
};

function calculateVisualUpgrades(
  before: ValidationReport | null,
  after: ValidationReport | null,
): VisualUpgradeMetrics | null {
  if (!before || !after) return null;
  const beforeByRule = new Map(before.results.map((result) => [result.rule_id, result]));
  const changedTo = (status: ValidationStatus) => after.results.filter((result) =>
    result.status === status && beforeByRule.get(result.rule_id)?.status !== status
  ).length;
  const unlockedRuleIds = after.results
    .filter((result) =>
      beforeByRule.get(result.rule_id)?.status === "NOT_EVALUATED" &&
      result.status !== "NOT_EVALUATED"
    )
    .map((result) => result.rule_id);
  return {
    notEvaluatedBefore: before.summary.not_evaluated,
    unlockedRuleIds,
    newPass: changedTo("PASS"),
    newFail: changedTo("FAIL"),
    newWarning: changedTo("WARNING"),
    remainingNotEvaluated: after.summary.not_evaluated,
  };
}

function ValidationPanel({
  report,
  beforeVisionReport,
  vision,
  loading,
  visionLoading,
  error,
  drawingId,
  catalog,
  onRun,
  onRunVision,
  onEvidence,
}: {
  report: ValidationReport | null;
  beforeVisionReport: ValidationReport | null;
  vision: VisionReport | null;
  loading: boolean;
  visionLoading: boolean;
  error: string | null;
  drawingId: string;
  catalog: ValidationRuleMetadata[];
  onRun: () => void;
  onRunVision: () => void;
  onEvidence: (result: ValidationResult) => void;
}) {
  const [view, setView] = useState<ValidationView>("summary");
  const [statusFilter, setStatusFilter] = useState<"ALL" | ValidationStatus>("ALL");
  const [category, setCategory] = useState("ALL");
  const [selected, setSelected] = useState<ValidationResult | null>(null);
  const visualUpgrades = useMemo(
    () => calculateVisualUpgrades(beforeVisionReport, report),
    [beforeVisionReport, report],
  );

  if (!report) {
    return (
      <div className="tab-content validation-empty">
        <SectionHeader
          eyebrow="Level 2 · Deterministic checks"
          title="Drawing validation"
          detail="Validation consumes the saved Level-1 evidence and does not reparse the PDF."
        />
        <div className="validation-start">
          <span>✓</span>
          <h3>Run the controlled checklist</h3>
          <p>Results remain separate from extraction and never constitute engineering approval.</p>
          <button type="button" className="primary-action validation-run" onClick={onRun} disabled={loading}>
            {loading ? <span className="loader loader--dark" /> : <span>→</span>}
            {loading ? "Running validation…" : "RUN LEVEL 2 VALIDATION"}
          </button>
          {error && <div className="alert" role="alert">{error}</div>}
        </div>
        {import.meta.env.DEV && !DEMO_MODE && (
          <aside className="development-diagnostic">
            <strong>Development diagnostic</strong>
            <span>Drawing ID: {drawingId}</span>
            <span>Level-1 status: COMPLETE</span>
            <span>Level-2 status: NOT RUN</span>
            <span>Level-3 status: {visionLoading ? "RUNNING" : vision ? "COMPLETE" : "NOT RUN"}</span>
            <span>Visual objects detected: {vision?.summary.objects_detected ?? 0}</span>
            <span>Vision API URL: {API_BASE}/drawings/{drawingId}/vision</span>
            <span>Level-2 rules upgraded: {visualUpgrades?.unlockedRuleIds.length ?? 0}</span>
            <span>Validation API URL: {API_BASE}/drawings/{drawingId}/validate</span>
            <span>Validation result count: 0</span>
          </aside>
        )}
      </div>
    );
  }

  const categories = [...new Set(report.results.map((result) => result.rule_category))].sort();
  const summary = report.summary;
  const viewStatus: Partial<Record<ValidationView, ValidationStatus>> = {
    failures: "FAIL",
    warnings: "WARNING",
    manual: "MANUAL_REVIEW",
    not_evaluated: "NOT_EVALUATED",
  };
  const effectiveStatus = viewStatus[view] ?? statusFilter;
  const filtered = report.results.filter((result) =>
    (effectiveStatus === "ALL" || result.status === effectiveStatus) &&
    (category === "ALL" || result.rule_category === category)
  );

  function openDetails(result: ValidationResult) {
    setSelected(result);
    setView("details");
    onEvidence(result);
  }

  const navigation: { id: ValidationView; label: string }[] = [
    { id: "summary", label: "Validation Summary" },
    { id: "checklist", label: "Checklist" },
    { id: "failures", label: "Failures" },
    { id: "warnings", label: "Warnings" },
    { id: "manual", label: "Manual Review" },
    { id: "not_evaluated", label: "Not Evaluated" },
    { id: "visual_upgrades", label: "Visual Upgrades" },
    { id: "details", label: "Rule Details" },
  ];

  const catalogCoverage = {
    automated: catalog.filter((rule) => rule.automation_status === "AUTOMATED").length,
    partial: catalog.filter((rule) => rule.automation_status === "PARTIALLY_AUTOMATED").length,
    manual: catalog.filter((rule) => rule.automation_status === "MANUAL").length,
    notImplemented: catalog.filter((rule) => rule.automation_status === "NOT_IMPLEMENTED").length,
  };

  return (
    <div className="tab-content validation-panel">
      <div className="validation-heading">
        <div>
          <span className="document-kicker">Level 2 · Rule set {report.rule_set_version}</span>
          <h2>Automated drawing checklist</h2>
        </div>
        <span className={`overall-status overall-status--${summary.overall_status.toLowerCase()}`}>
          {summary.overall_status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="validation-actions">
        <button type="button" onClick={onRun} disabled={loading}>
          {loading ? "VALIDATION RUNNING…" : "RE-RUN VALIDATION"}
        </button>
        <button type="button" className="visual-analysis-action" onClick={onRunVision} disabled={visionLoading}>
          {visionLoading ? "VISUAL ANALYSIS RUNNING…" : vision ? "RE-RUN VISUAL ANALYSIS" : "RUN VISUAL ANALYSIS"}
        </button>
        <a href={`${API_BASE}/drawings/${drawingId}/validation/export/json`}>EXPORT VALIDATION JSON</a>
        <a href={`${API_BASE}/drawings/${drawingId}/validation/export/csv`}>EXPORT VALIDATION CSV</a>
      </div>
      {import.meta.env.DEV && !DEMO_MODE && (
        <aside className="development-diagnostic">
          <strong>Development diagnostic</strong>
          <span>Drawing ID: {drawingId}</span>
          <span>Level-1 status: COMPLETE</span>
          <span>Level-2 status: {summary.overall_status}</span>
          <span>Level-3 status: {visionLoading ? "RUNNING" : vision ? "COMPLETE" : "NOT RUN"}</span>
          <span>Visual objects detected: {vision?.summary.objects_detected ?? 0}</span>
          <span>Vision API URL: {API_BASE}/drawings/{drawingId}/vision</span>
          <span>Level-2 rules upgraded: {visualUpgrades?.unlockedRuleIds.length ?? 0}</span>
          <span>Validation API URL: {API_BASE}/drawings/{drawingId}/validate</span>
          <span>Validation result count: {report.results.length}</span>
        </aside>
      )}
      <div className="validation-nav" role="tablist" aria-label="Validation sections">
        {navigation.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={view === item.id ? "validation-nav__active" : ""}
            onClick={() => setView(item.id)}
            disabled={item.id === "details" && !selected}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === "summary" ? (
        <>
          <div className="validation-stats">
            {[
              ["Total checks", summary.total_rules, "neutral"],
              ["Passed", summary.passed, "pass"],
              ["Failed", summary.failed, "fail"],
              ["Warnings", summary.warnings, "warning"],
              ["Manual review", summary.manual_review, "manual"],
              ["Not applicable", summary.not_applicable, "muted"],
              ["Not evaluated", summary.not_evaluated, "muted"],
            ].map(([label, value, tone]) => (
              <div className={`validation-stat validation-stat--${tone}`} key={label}>
                <strong>{value}</strong><span>{label}</span>
              </div>
            ))}
          </div>
          <div className="validation-disclaimer">
            <strong>Review assistance only</strong>
            <p>{report.disclaimer}</p>
            {summary.overall_status === "REVIEW_REQUIRED" && (
              <p className="review-required-explanation">
                Automated validation completed, but one or more checks require engineering review.
              </p>
            )}
            <small>Level-2 execution: {report.timing.level2_validation_ms.toFixed(2)} ms · PDF was not reparsed</small>
          </div>
          <section className="coverage-panel">
            <div>
              <span className="document-kicker">Rule catalog coverage</span>
              <h3>Level-2 automation profile</h3>
              <p>Catalog status is loaded from the backend rule registry, not calculated from this drawing's applicability.</p>
            </div>
            <div className="coverage-grid">
              <div><strong>{catalogCoverage.automated}</strong><span>Fully Automated</span></div>
              <div><strong>{catalogCoverage.partial}</strong><span>Partially Automated</span></div>
              <div><strong>{catalogCoverage.manual}</strong><span>Manual</span></div>
              <div><strong>{catalogCoverage.notImplemented}</strong><span>Not Implemented</span></div>
            </div>
          </section>
        </>
      ) : view === "visual_upgrades" ? (
        <section className="visual-upgrades-panel">
          <div>
            <span className="document-kicker">Level 2 + Level 3</span>
            <h3>Visual Upgrades</h3>
            <p>Counts compare the saved Level-2 result immediately before visual analysis with the post-Level-3 validation result.</p>
          </div>
          {visualUpgrades ? (
            <>
              <div className="visual-upgrades-grid">
                {[
                  ["Not Evaluated Before Level 3", visualUpgrades.notEvaluatedBefore],
                  ["Rules Unlocked by Level 3", visualUpgrades.unlockedRuleIds.length],
                  ["New Pass", visualUpgrades.newPass],
                  ["New Fail", visualUpgrades.newFail],
                  ["New Warning", visualUpgrades.newWarning],
                  ["Remaining Not Evaluated", visualUpgrades.remainingNotEvaluated],
                ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
              </div>
              <p className="visual-upgrades-rules">
                <strong>Rules unlocked:</strong> {visualUpgrades.unlockedRuleIds.length ? visualUpgrades.unlockedRuleIds.join(", ") : "None"}
              </p>
            </>
          ) : (
            <div className="inline-empty">Run Level 2, then Run Visual Analysis to calculate the before/after rule changes.</div>
          )}
        </section>
      ) : view === "details" && selected ? (
        <article className="rule-detail">
          <header>
            <span className={`status-badge status-badge--${selected.status.toLowerCase()}`}>{selected.status.replaceAll("_", " ")}</span>
            <span>{selected.severity} · {selected.automation_type.replaceAll("_", " ")}</span>
            <h3>{selected.rule_id} · {selected.rule_name}</h3>
            {selected.evidence.some((item) => item.source_field.startsWith("vision.objects.")) && (
              <span className="visual-evidence-badge">Visual Evidence Available</span>
            )}
          </header>
          <dl>
            <div><dt>Rule description</dt><dd>{selected.rule_description}</dd></div>
            <div><dt>Category</dt><dd>{selected.rule_category}</dd></div>
            <div><dt>Automation type</dt><dd>{selected.automation_type.replaceAll("_", " ")}</dd></div>
            <div><dt>Source requirement</dt><dd>{selected.source_requirement}</dd></div>
            <div><dt>Expected condition</dt><dd>{selected.expected_condition}</dd></div>
            <div><dt>Actual condition</dt><dd>{selected.actual_condition}</dd></div>
            <div><dt>Explanation</dt><dd>{selected.message}</dd></div>
            <div><dt>Recommendation</dt><dd>{selected.recommendation}</dd></div>
            <div><dt>Rule version</dt><dd>{selected.rule_version}</dd></div>
          </dl>
          <button type="button" className="evidence-action" onClick={() => onEvidence(selected)} disabled={!selected.evidence.some((item) => item.bounding_box && item.page_number)}>
            Locate {selected.evidence.filter((item) => item.bounding_box && item.page_number).length} evidence region(s) on PDF
          </button>
          <div className="rule-evidence-list">
            {selected.evidence.map((item, index) => {
              const objectId = item.source_field.startsWith("vision.objects.")
                ? item.source_field.slice("vision.objects.".length)
                : null;
              const visualObject = objectId
                ? vision?.objects.find((candidate) => candidate.object_id === objectId)
                : null;
              const label = visualObject
                ? `${visualObject.object_type.replaceAll("_", " ")} ${visualObject.normalized_text ?? visualObject.raw_text ?? ""}`.trim()
                : item.source_field;
              return (
                <div key={`${item.source_field}-${index}`}>
                  {item.page_number && item.bounding_box ? (
                    <button
                      type="button"
                      className="evidence-link rule-evidence-link"
                      onClick={() => onEvidence({ ...selected, evidence: [item] })}
                    >
                      {label}
                    </button>
                  ) : <strong>{label}</strong>}
                  <span>Page {item.page_number ?? "—"} · {Math.round(item.confidence * 100)}% · {item.extraction_method?.replaceAll("_", " ") ?? "no method"}</span>
                  <p>{formatValue(item.extracted_value)}</p>
                </div>
              );
            })}
          </div>
        </article>
      ) : (
        <>
          <div className="validation-filters">
            <div>
              {(["ALL", "FAIL", "WARNING", "MANUAL_REVIEW", "PASS", "NOT_EVALUATED", "NOT_APPLICABLE"] as const).map((status) => (
                <button type="button" className={effectiveStatus === status ? "active" : ""} onClick={() => { setStatusFilter(status); setView("checklist"); }} key={status}>
                  {status.replaceAll("_", " ")}
                </button>
              ))}
            </div>
            <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Validation category filter">
              <option value="ALL">All categories</option>
              {categories.map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </div>
          <div className="validation-table-wrap">
            <table className="validation-table">
              <thead><tr><th>Rule</th><th>Requirement</th><th>Status</th><th>Severity</th><th>Evidence</th></tr></thead>
              <tbody>
                {filtered.map((result) => (
                  <tr key={result.rule_id}>
                    <td><button type="button" className="rule-link" onClick={() => openDetails(result)}>{result.rule_id}</button></td>
                    <td>{result.rule_name}</td>
                    <td><span className={`status-badge status-badge--${result.status.toLowerCase()}`}>{result.status.replaceAll("_", " ")}</span></td>
                    <td>{result.severity}</td>
                    <td><button type="button" className="evidence-link" onClick={() => onEvidence(result)} disabled={!result.evidence.some((item) => item.bounding_box && item.page_number)}>{result.evidence.some((item) => item.source_field.startsWith("vision.objects.")) ? "Visual Evidence Available" : `${result.evidence.length} source(s)`}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <p className="inline-empty">No rules match the selected filters.</p>}
          </div>
        </>
      )}
    </div>
  );
}

const VISUAL_FILTERS: { type: VisualObjectType; label: string; icon: string }[] = [
  { type: "REVISION_TRIANGLE", label: "Revision Triangles", icon: "△" },
  { type: "BOM_BALLOON", label: "Balloons", icon: "○" },
  { type: "SCC_SYMBOL", label: "SCC", icon: "⬟" },
  { type: "DATUM_SYMBOL", label: "Datums", icon: "Ⓐ" },
  { type: "GDT_FRAME", label: "GD&T", icon: "▭" },
  { type: "VIEW_ARROW", label: "View Arrows", icon: "➜" },
  { type: "SECTION_ARROW", label: "Section Arrows", icon: "⇥" },
  { type: "DETAIL_CALLOUT", label: "Details", icon: "◎" },
  { type: "FLAG_NOTE", label: "Flag Notes", icon: "⚑" },
  { type: "SUPPLIER_RASTER_TEXT", label: "OCR Regions", icon: "▱" },
];

const VISUAL_TABLE_FILTERS: { type: "ALL" | VisualObjectType; label: string }[] = [
  { type: "ALL", label: "All" },
  { type: "REVISION_TRIANGLE", label: "Revision Triangles" },
  { type: "BOM_BALLOON", label: "BOM Balloons" },
  { type: "DATUM_SYMBOL", label: "Datum" },
  { type: "GDT_FRAME", label: "GD&T" },
  { type: "SCC_SYMBOL", label: "SCC" },
  { type: "FLAG_NOTE", label: "Flag Notes" },
  { type: "SUPPLIER_RASTER_TEXT", label: "Supplier OCR" },
];

function VisualIntelligencePanel({
  report,
  loading,
  error,
  drawingId,
  visibleTypes,
  onToggleType,
  onRun,
  onSelect,
}: {
  report: VisionReport | null;
  loading: boolean;
  error: string | null;
  drawingId: string;
  visibleTypes: Set<VisualObjectType>;
  onToggleType: (type: VisualObjectType) => void;
  onRun: () => void;
  onSelect: (item: VisualObject) => void;
}) {
  const [reviewed, setReviewed] = useState<Record<string, VisualReviewAction>>({});
  const [objectFilter, setObjectFilter] = useState<"ALL" | VisualObjectType>("ALL");

  async function review(item: VisualObject, action: VisualReviewAction) {
    const correctedLabel = action === "CORRECT_LABEL"
      ? window.prompt("Enter the corrected visual label", item.normalized_text ?? "")
      : null;
    if (action === "CORRECT_LABEL" && !correctedLabel) return;
    const response = await fetch(
      `${API_BASE}/drawings/${drawingId}/vision/objects/${item.object_id}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object_id: item.object_id,
          action,
          corrected_label: correctedLabel,
          reviewer_comment: "Recorded from Visual Intelligence review UI",
        }),
      },
    );
    if (response.ok) setReviewed((current) => ({ ...current, [item.object_id]: action }));
  }

  if (!report) {
    return (
      <div className="tab-content validation-empty">
        <SectionHeader
          eyebrow="Level 3 · Local visual evidence"
          title="Visual intelligence"
          detail="Detect drawing objects with traditional CV, targeted OCR, and explicit confidence gates."
        />
        <div className="validation-start">
          <span>◫</span>
          <h3>Analyze visible drawing annotations</h3>
          <p>Level 3 runs locally and remains separate from Level-1 extraction and engineering approval.</p>
          <button type="button" className="primary-action validation-run" onClick={onRun} disabled={loading}>
            {loading ? <span className="loader loader--dark" /> : <span>→</span>}
            {loading ? "Analyzing visual evidence…" : "RUN VISUAL ANALYSIS"}
          </button>
          {error && <div className="alert" role="alert">{error}</div>}
        </div>
      </div>
    );
  }

  const count = (type: VisualObjectType) => report.summary.objects_by_type[type] ?? 0;
  const filteredObjects = objectFilter === "ALL"
    ? report.objects
    : report.objects.filter((item) => item.object_type === objectFilter);
  return (
    <div className="tab-content visual-panel">
      <div className="validation-heading">
        <div>
          <span className="document-kicker">Level 3 · Evidence only · v{report.level3_version}</span>
          <h2>Visual intelligence</h2>
        </div>
        <span className="overall-status">{report.summary.objects_detected} OBJECTS</span>
      </div>
      <div className="validation-actions">
        <button type="button" onClick={onRun} disabled={loading}>{loading ? "ANALYSIS RUNNING…" : "RE-RUN VISUAL ANALYSIS"}</button>
        <a href={`${API_BASE}/drawings/${drawingId}/vision/export/json`}>EXPORT VISUAL JSON</a>
      </div>
      <div className="visual-summary">
        {[
          ["Objects detected", report.summary.objects_detected],
          ["Revision triangles", count("REVISION_TRIANGLE")],
          ["Balloons", count("BOM_BALLOON")],
          ["SCC symbols", count("SCC_SYMBOL")],
          ["Datums", count("DATUM_SYMBOL")],
          ["GD&T frames", count("GDT_FRAME")],
          ["Flag notes", count("FLAG_NOTE")],
          ["Raster OCR regions", count("SUPPLIER_RASTER_TEXT")],
          ["Low confidence", report.summary.low_confidence_count],
        ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <section className="visual-controls">
        <h3>PDF overlay controls</h3>
        <div>
          {VISUAL_FILTERS.map((filter) => (
            <button
              type="button"
              className={visibleTypes.has(filter.type) ? "active" : ""}
              onClick={() => onToggleType(filter.type)}
              aria-pressed={visibleTypes.has(filter.type)}
              key={filter.type}
            >
              <span>{filter.icon}</span>{filter.label} <small>{count(filter.type)}</small>
            </button>
          ))}
        </div>
      </section>
      {error && <div className="alert" role="alert">{error}</div>}
      {report.summary.warnings.length > 0 && (
        <div className="raster-message">
          <strong>Detector notices</strong>
          {report.summary.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      )}
      <div className="visual-table-filters" aria-label="Detected object filters">
        {VISUAL_TABLE_FILTERS.map((filter) => (
          <button
            type="button"
            className={objectFilter === filter.type ? "active" : ""}
            onClick={() => setObjectFilter(filter.type)}
            key={filter.type}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="visual-table-wrap">
        <table className="visual-table">
          <thead><tr><th>Object Type</th><th>Detected Value</th><th>Page</th><th>Confidence</th><th>Detector</th><th>Linked Rule</th><th>Review</th></tr></thead>
          <tbody>
            {filteredObjects.map((item) => (
              <tr key={item.object_id}>
                <td><button type="button" className="rule-link" onClick={() => onSelect(item)}>{item.object_type.replaceAll("_", " ")}</button></td>
                <td>{item.normalized_text ?? item.raw_text ?? "—"}</td>
                <td>{item.page_number}</td>
                <td>{Math.round(item.confidence * 100)}%</td>
                <td>{item.detector.replaceAll("_", " ")}</td>
                <td>{VISUAL_RULES_BY_TYPE[item.object_type]?.join(", ") ?? "—"}</td>
                <td className="visual-review-actions">
                  {reviewed[item.object_id] ? <span>{reviewed[item.object_id].replaceAll("_", " ")}</span> : <>
                    <button type="button" onClick={() => void review(item, "CONFIRM")}>Confirm</button>
                    <button type="button" onClick={() => void review(item, "REJECT")}>Reject</button>
                    <button type="button" onClick={() => void review(item, "CORRECT_LABEL")}>Correct label</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredObjects.length && <p className="inline-empty">No visual objects match this filter.</p>}
      </div>
      {import.meta.env.DEV && !DEMO_MODE && (
        <aside className="development-diagnostic">
          <strong>Development diagnostic</strong>
          <span>Drawing ID: {drawingId}</span>
          <span>Level-1 status: COMPLETE</span>
          <span>Level-2 status: COMPLETE</span>
          <span>Level-3 status: COMPLETE</span>
          <span>Visual objects detected: {report.summary.objects_detected}</span>
          <span>Vision API URL: {API_BASE}/drawings/{drawingId}/vision</span>
          <span>Level-2 rules upgraded: calculated in Validation → Visual Upgrades</span>
        </aside>
      )}
      <div className="validation-disclaimer">
        <strong>Visual review assistance only</strong>
        <p>{report.disclaimer}</p>
        <small>Render {report.timing.render_time_ms.toFixed(1)} ms · OCR {report.timing.ocr_time_ms.toFixed(1)} ms · Total {report.timing.total_time_ms.toFixed(1)} ms</small>
      </div>
    </div>
  );
}

type RelationshipView = "summary" | "findings" | "traceability" | "graph";

const GRAPH_FILTERS = [
  { id: "ALL", label: "All", types: [] },
  { id: "BOM", label: "BOM ↔ Balloon", types: ["BOM_ITEM", "BALLOON"] },
  { id: "REVISION", label: "Revision ↔ Triangle", types: ["REVISION", "REVISION_TRIANGLE"] },
  { id: "NOTE", label: "Note ↔ Callout", types: ["NOTE", "NOTE_CALLOUT"] },
  { id: "GDT", label: "Datum ↔ GD&T", types: ["DATUM", "GDT_FRAME"] },
  { id: "SCC", label: "SCC ↔ Note/BOM", types: ["SCC_SYMBOL", "NOTE", "BOM_ITEM"] },
  { id: "SUPPLIER", label: "Supplier ↔ Part", types: ["SUPPLIER", "SUPPLIER_PART", "PART_LIST_ITEM"] },
];

function RelationshipIntelligencePanel({
  report,
  loading,
  error,
  drawingId,
  onRun,
  onEvidence,
  onEntity,
}: {
  report: RelationshipReport | null;
  loading: boolean;
  error: string | null;
  drawingId: string;
  onRun: () => void;
  onEvidence: (finding: RelationshipResult) => void;
  onEntity: (entity: RelationshipReport["graph"]["nodes"][number]) => void;
}) {
  const [view, setView] = useState<RelationshipView>("summary");
  const [selected, setSelected] = useState<RelationshipResult | null>(null);
  const [graphFilter, setGraphFilter] = useState("ALL");

  if (!report) {
    return (
      <div className="tab-content validation-empty">
        <SectionHeader
          eyebrow="Level 4 · Explainable relationships"
          title="Relationship intelligence"
          detail="Connect Level-1 entities, Level-2 findings, and Level-3 visual objects without re-extracting the PDF."
        />
        <div className="validation-start">
          <span>↔</span>
          <h3>Build engineering traceability</h3>
          <p>Level 4 compares explicit identifiers and evidence. Missing semantics remain visible for engineer review.</p>
          <button type="button" className="primary-action validation-run" onClick={onRun} disabled={loading}>
            {loading ? <span className="loader loader--dark" /> : <span>→</span>}
            {loading ? "Building relationships…" : "RUN RELATIONSHIP ANALYSIS"}
          </button>
          {error && <div className="alert" role="alert">{error}</div>}
        </div>
      </div>
    );
  }

  const summary = report.summary;
  const selectedFilter = GRAPH_FILTERS.find((item) => item.id === graphFilter) ?? GRAPH_FILTERS[0];
  const nodes = selectedFilter.id === "ALL"
    ? report.graph.nodes
    : report.graph.nodes.filter((node) => selectedFilter.types.includes(node.entity_type));
  const nodeIds = new Set(nodes.map((node) => node.entity_id));
  const edges = report.graph.edges.filter((edge) =>
    nodeIds.has(edge.source_entity_id) && (!edge.target_entity_id || nodeIds.has(edge.target_entity_id))
  );
  const nodeById = new Map(report.graph.nodes.map((node) => [node.entity_id, node]));
  const bomNodes = report.graph.nodes.filter((node) => node.entity_type === "BOM_ITEM");

  return (
    <div className="tab-content relationship-panel">
      <div className="validation-heading">
        <div>
          <span className="document-kicker">Level 4 · Relationship set {report.level4_version}</span>
          <h2>Relationship intelligence</h2>
        </div>
        <span className={`overall-status overall-status--${summary.overall_status.toLowerCase()}`}>{summary.overall_status.replaceAll("_", " ")}</span>
      </div>
      <div className="validation-actions">
        <button type="button" onClick={onRun} disabled={loading}>{loading ? "RELATIONSHIPS RUNNING…" : "RE-RUN RELATIONSHIP ANALYSIS"}</button>
        <a href={`${API_BASE}/drawings/${drawingId}/relationships/export/json`}>EXPORT RELATIONSHIPS JSON</a>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="validation-nav" role="tablist" aria-label="Relationship sections">
        {([
          ["summary", "Summary"],
          ["findings", "Findings"],
          ["traceability", "Traceability"],
          ["graph", "Graph"],
        ] as [RelationshipView, string][]).map(([id, label]) => (
          <button type="button" role="tab" aria-selected={view === id} className={view === id ? "validation-nav__active" : ""} onClick={() => setView(id)} key={id}>{label}</button>
        ))}
      </div>

      {view === "summary" ? (
        <>
          <div className="relationship-summary-grid">
            {[
              ["Relationships checked", summary.relationships_checked],
              ["Passed relationships", summary.passed],
              ["Broken links", summary.broken],
              ["Warnings", summary.warnings],
              ["Manual review", summary.manual_review],
              ["High priority findings", summary.high_priority_findings],
            ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
          </div>
          <section className="correlation-panel">
            <h3>Issue Correlation / Probable Relationship</h3>
            {report.correlations.length ? report.correlations.map((item) => (
              <article key={item.correlation_id}>
                <span className={`priority-badge priority-badge--${item.priority.toLowerCase()}`}>{item.priority}</span>
                <strong>{item.title}</strong>
                <p>{item.explanation}</p>
                <small>{item.qualifier}</small>
              </article>
            )) : <p className="inline-empty">No multi-finding issue correlation was established.</p>}
          </section>
          <div className="validation-disclaimer"><strong>Structured review assistance</strong><p>{report.disclaimer}</p><small>Level-4 execution: {report.timing.level4_relationship_ms.toFixed(2)} ms · PDF was not re-read or re-rendered</small></div>
        </>
      ) : view === "findings" ? (
        <>
          <div className="relationship-findings-table">
            <table>
              <thead><tr><th>Finding</th><th>Relationship</th><th>Status</th><th>Priority</th><th>Confidence</th><th>Evidence</th></tr></thead>
              <tbody>{report.findings.map((finding) => (
                <tr key={finding.finding_id}>
                  <td><button type="button" className="rule-link" onClick={() => setSelected(finding)}>{finding.name}</button></td>
                  <td>{finding.relationship_rule_id}</td>
                  <td><span className={`status-badge status-badge--${finding.status.toLowerCase()}`}>{finding.status.replaceAll("_", " ")}</span></td>
                  <td><span className={`priority-badge priority-badge--${finding.priority.toLowerCase()}`}>{finding.priority}</span></td>
                  <td>{Math.round(finding.confidence * 100)}%</td>
                  <td><button type="button" className="evidence-link" onClick={() => onEvidence(finding)} disabled={!finding.evidence.some((item) => item.page_number && item.bounding_box)}>VIEW</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {selected && (
            <article className="relationship-detail">
              <button type="button" className="relationship-detail__close" onClick={() => setSelected(null)}>Close details</button>
              <h3>{selected.name}</h3>
              <dl>
                <div><dt>Expected</dt><dd>{selected.expected_relationship}</dd></div>
                <div><dt>Actual</dt><dd>{selected.actual_relationship}</dd></div>
                <div><dt>Explanation</dt><dd>{selected.explanation}</dd></div>
                <div><dt>Recommendation</dt><dd>{selected.recommendation}</dd></div>
                <div><dt>Linked Level-2 rules</dt><dd>{selected.related_validation_rule_ids.join(", ") || "None"}</dd></div>
              </dl>
            </article>
          )}
        </>
      ) : view === "traceability" ? (
        <div className="traceability-list">
          {bomNodes.length ? bomNodes.map((node) => {
            const relatedEdges = report.graph.edges.filter((edge) => edge.source_entity_id === node.entity_id || edge.target_entity_id === node.entity_id);
            const balloon = relatedEdges.map((edge) => nodeById.get(edge.source_entity_id === node.entity_id ? edge.target_entity_id ?? "" : edge.source_entity_id)).find((entity) => entity?.entity_type === "BALLOON");
            const broken = relatedEdges.some((edge) => edge.relationship_type === "MISSING_LINK");
            return (
              <article key={node.entity_id}>
                <header><span>BOM ITEM</span><strong>{formatValue(node.value)}</strong></header>
                <dl>
                  <div><dt>Part No</dt><dd>{formatValue(node.attributes.part_number)}</dd></div>
                  <div><dt>Quantity</dt><dd>{formatValue(node.attributes.quantity)}</dd></div>
                  <div><dt>Balloon</dt><dd>{balloon ? formatValue(balloon.value) : "NOT FOUND"}</dd></div>
                  <div><dt>Status</dt><dd>{broken ? "REVIEW REQUIRED" : balloon ? "LINKED" : "NOT EVALUATED"}</dd></div>
                </dl>
                <button type="button" onClick={() => onEntity(node)} disabled={!node.page_number || !node.bounding_box}>Locate BOM evidence</button>
              </article>
            );
          }) : <p className="inline-empty">No BOM entities are available for traceability.</p>}
        </div>
      ) : (
        <div className="relationship-graph-view">
          <div className="graph-filters">{GRAPH_FILTERS.map((filter) => <button type="button" className={graphFilter === filter.id ? "active" : ""} onClick={() => setGraphFilter(filter.id)} key={filter.id}>{filter.label}</button>)}</div>
          <div className="graph-canvas">
            <div className="graph-nodes">{nodes.map((node) => (
              <button type="button" onClick={() => onEntity(node)} disabled={!node.page_number || !node.bounding_box} key={node.entity_id}>
                <span>{node.entity_type.replaceAll("_", " ")}</span><strong>{formatValue(node.value)}</strong><small>{Math.round(node.confidence * 100)}% · {node.source_level.replace("LEVEL_", "L")}</small>
              </button>
            ))}</div>
            <div className="graph-edges"><h3>Visible relationships</h3>{edges.map((edge) => <div key={edge.relationship_id}><span>{nodeById.get(edge.source_entity_id)?.entity_type}</span><strong>{edge.relationship_type.replaceAll("_", " ")}</strong><span>{edge.target_entity_id ? nodeById.get(edge.target_entity_id)?.entity_type : "MISSING"}</span></div>)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function FinalReviewPanel({
  drawing,
  validation,
  vision,
  relationships,
  completeReport,
  drawingId,
  completeLoading,
  onRunComplete,
  onFinding,
}: {
  drawing: DrawingDocument;
  validation: ValidationReport | null;
  vision: VisionReport | null;
  relationships: RelationshipReport | null;
  completeReport: CompleteAnalysisReport | null;
  drawingId: string;
  completeLoading: boolean;
  onRunComplete: () => void;
  onFinding: (finding: RelationshipResult) => void;
}) {
  const status = completeReport?.final_system_status
    ?? (relationships?.summary.overall_status === "FAIL" || validation?.summary.overall_status === "FAIL" ? "FAIL"
      : relationships && validation ? "REVIEW_REQUIRED" : "NOT RUN");
  const topFindings = completeReport?.top_findings
    ?? relationships?.findings.filter((item) => !["PASS", "NOT_APPLICABLE"].includes(item.status)).slice(0, 10)
    ?? [];
  return (
    <div className="tab-content final-review">
      <div className="final-review__heading">
        <div><span className="document-kicker">Unified Engineering Review</span><h2>Engineering Drawing Review Summary</h2></div>
        <span className={`overall-status overall-status--${status.toLowerCase()}`}>{status.replaceAll("_", " ")}</span>
      </div>
      <button type="button" className="complete-analysis-button" onClick={onRunComplete} disabled={completeLoading}>{completeLoading ? "COMPLETE ANALYSIS RUNNING…" : "RUN COMPLETE ANALYSIS"}</button>
      <section className="final-review-section"><h3>Drawing Information</h3><dl className="final-review-info">
        <div><dt>Drawing No</dt><dd>{drawing.drawing_number.value ?? "—"}</dd></div><div><dt>Revision</dt><dd>{drawing.revision.value ?? "—"}</dd></div><div><dt>Part Name</dt><dd>{drawing.part_name.value ?? "—"}</dd></div><div><dt>Pages</dt><dd>{drawing.page_count.value ?? "—"}</dd></div><div><dt>Document Type</dt><dd>{drawing.document_type.value?.replaceAll("_", " ") ?? "—"}</dd></div>
      </dl></section>
      <section className="final-review-section"><h3>Level Status</h3><div className="level-status-grid">
        {["Level 1", "Level 2", "Level 3", "Level 4"].map((label, index) => { const complete = [true, Boolean(validation), Boolean(vision), Boolean(relationships)][index]; return <div key={label}><span>{label}</span><strong>{complete ? "✓ COMPLETE" : "NOT RUN"}</strong></div>; })}
      </div></section>
      <section className="final-review-kpis">
        <div><h3>Validation</h3><p><strong>{validation?.summary.total_rules ?? 0}</strong> Total Checks</p><span>{validation?.summary.passed ?? 0} Pass · {validation?.summary.failed ?? 0} Fail · {validation?.summary.warnings ?? 0} Warning · {validation?.summary.manual_review ?? 0} Manual · {validation?.summary.not_evaluated ?? 0} Not Evaluated</span></div>
        <div><h3>Visual Intelligence</h3><p><strong>{vision?.summary.objects_detected ?? 0}</strong> Objects Detected</p><span>{vision?.summary.low_confidence_count ?? 0} Low Confidence · {vision?.summary.objects_by_type.SUPPLIER_RASTER_TEXT ?? 0} OCR Regions</span></div>
        <div><h3>Relationship Intelligence</h3><p><strong>{relationships?.summary.relationships_checked ?? 0}</strong> Relationships Checked</p><span>{relationships?.summary.broken ?? 0} Broken Links · {relationships?.summary.warnings ?? 0} Warnings</span></div>
      </section>
      <section className="final-review-section"><h3>Top Findings</h3>{topFindings.length ? <ol className="top-findings">{topFindings.map((finding) => <li key={finding.finding_id}><button type="button" onClick={() => onFinding(finding)}><span className={`priority-badge priority-badge--${finding.priority.toLowerCase()}`}>{finding.priority}</span><strong>{finding.name}</strong><small>{finding.actual_relationship}</small></button></li>)}</ol> : <p className="inline-empty">Run complete analysis to generate prioritized findings.</p>}</section>
      <section className="final-review-section final-review-export"><h3>Engineering Drawing Intelligence Report</h3><p>Exports include drawing metadata, checklist results, visual detections, relationship findings, evidence references, status, and known limitations.</p><div><a href={`${API_BASE}/drawings/${drawingId}/report/export/json`}>EXPORT COMPLETE JSON</a><a href={`${API_BASE}/drawings/${drawingId}/report/export/csv`}>EXPORT CHECKLIST & FINDINGS CSV</a></div></section>
      <div className="validation-disclaimer"><strong>AUTOMATED REVIEW COMPLETE</strong><p>ENGINEER REVIEW REQUIRED. Final engineering approval remains human-controlled.</p></div>
    </div>
  );
}

function RawJson({ drawing }: { drawing: DrawingDocument }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(drawing, null, 2);
  async function copy() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="tab-content">
      <SectionHeader eyebrow="Machine-readable output" title="Raw JSON" detail="Complete evidence-preserving Level-1 extraction response." />
      <div className="json-panel">
        <div className="json-panel__toolbar"><span>drawing.json</span><button type="button" onClick={copy}>{copied ? "Copied" : "Copy JSON"}</button></div>
        <pre>{json}</pre>
      </div>
    </div>
  );
}

function AnalysisPage({
  id,
  file,
  drawing,
  onReset,
}: {
  id: string;
  file: File;
  drawing: DrawingDocument;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<AnalysisTab>("overview");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const [validationSelection, setValidationSelection] = useState<ValidationOverlay[]>([]);
  const [visualSelection, setVisualSelection] = useState<VisualObject | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [preVisionValidation, setPreVisionValidation] = useState<ValidationReport | null>(null);
  const [validationCatalog, setValidationCatalog] = useState<ValidationRuleMetadata[]>([]);
  const [validationLoading, setValidationLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [vision, setVision] = useState<VisionReport | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<RelationshipReport | null>(null);
  const [relationshipLoading, setRelationshipLoading] = useState(false);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [completeReport, setCompleteReport] = useState<CompleteAnalysisReport | null>(null);
  const [completeLoading, setCompleteLoading] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completeSteps, setCompleteSteps] = useState<Record<"level1" | "level2" | "level3" | "level4" | "review", "NOT RUN" | "RUNNING" | "COMPLETE">>({
    level1: "COMPLETE",
    level2: "NOT RUN",
    level3: "NOT RUN",
    level4: "NOT RUN",
    review: "NOT RUN",
  });
  const [visibleVisualTypes, setVisibleVisualTypes] = useState<Set<VisualObjectType>>(
    () => new Set(VISUAL_FILTERS.map((item) => item.type)),
  );
  const [showExtractedRegions, setShowExtractedRegions] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function loadValidationState() {
      try {
        const [catalogResponse, reportResponse, visionResponse, relationshipResponse, completeResponse] = await Promise.all([
          fetch(`${API_BASE}/drawings/${id}/validation/rules`, { signal: controller.signal }),
          fetch(`${API_BASE}/drawings/${id}/validation`, { signal: controller.signal }),
          fetch(`${API_BASE}/drawings/${id}/vision`, { signal: controller.signal }),
          fetch(`${API_BASE}/drawings/${id}/relationships`, { signal: controller.signal }),
          fetch(`${API_BASE}/drawings/${id}/report`, { signal: controller.signal }),
        ]);
        if (catalogResponse.ok) {
          setValidationCatalog(await catalogResponse.json() as ValidationRuleMetadata[]);
        }
        if (reportResponse.ok) {
          setValidation(await reportResponse.json() as ValidationReport);
        }
        if (visionResponse.ok) {
          setVision(await visionResponse.json() as VisionReport);
        }
        if (relationshipResponse.ok) {
          setRelationships(await relationshipResponse.json() as RelationshipReport);
        }
        if (completeResponse.ok) {
          setCompleteReport(await completeResponse.json() as CompleteAnalysisReport);
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setValidationError("Validation metadata could not be loaded.");
        }
      }
    }
    void loadValidationState();
    return () => controller.abort();
  }, [id]);

  const knownFields = useMemo(() => {
    const fields: ExtractedField[] = [];
    for (const { key } of OVERVIEW_GROUPS.flatMap((group) => group.fields)) {
      const candidate = drawing[key];
      if (isExtractedField(candidate)) fields.push(candidate);
    }
    return fields.filter((field) => field.value !== null).length;
  }, [drawing]);

  const locatedFields = useMemo(() => {
    const unique = new Map<string, EvidenceSelection>();
    for (const field of collectLocatedFields(drawing)) {
      const key = `${field.pageNumber}:${field.boundingBox.join(":")}`;
      if (!unique.has(key)) unique.set(key, field);
    }
    return [...unique.values()];
  }, [drawing]);

  function selectEvidence(next: EvidenceSelection) {
    setSelection(next);
    setValidationSelection([]);
    setVisualSelection(null);
    setPage(next.pageNumber);
  }

  function selectValidationEvidence(result: ValidationResult) {
    const overlays = result.evidence.flatMap((item): ValidationOverlay[] =>
      item.page_number && item.bounding_box
        ? [{
            label: `${result.rule_id} · ${item.source_field}`,
            pageNumber: item.page_number,
            boundingBox: item.bounding_box,
            status: result.status,
            confidence: item.confidence,
            rawText: item.raw_text,
            method: item.extraction_method,
          }]
        : []
    );
    setSelection(null);
    setVisualSelection(null);
    setValidationSelection(overlays);
    if (overlays[0]) setPage(overlays[0].pageNumber);
  }

  function selectRelationshipEvidence(result: RelationshipResult) {
    const overlays = result.evidence.flatMap((item): ValidationOverlay[] =>
      item.page_number && item.bounding_box
        ? [{
            label: `${result.relationship_rule_id} · ${item.source_reference}`,
            pageNumber: item.page_number,
            boundingBox: item.bounding_box,
            status: result.status,
            confidence: item.confidence,
            rawText: typeof item.value === "string" ? item.value : null,
            method: item.extraction_method,
          }]
        : []
    );
    setSelection(null);
    setVisualSelection(null);
    setValidationSelection(overlays);
    if (overlays[0]) setPage(overlays[0].pageNumber);
  }

  function selectRelationshipEntity(entity: RelationshipReport["graph"]["nodes"][number]) {
    if (!entity.page_number || !entity.bounding_box) return;
    setSelection(null);
    setVisualSelection(null);
    setValidationSelection([{
      label: `${entity.entity_type.replaceAll("_", " ")} · ${formatValue(entity.value)}`,
      pageNumber: entity.page_number,
      boundingBox: entity.bounding_box,
      status: "WARNING",
      confidence: entity.confidence,
      rawText: typeof entity.value === "string" ? entity.value : null,
      method: typeof entity.attributes.extraction_method === "string" ? entity.attributes.extraction_method : null,
    }]);
    setPage(entity.page_number);
  }

  async function runValidation() {
    if (validationLoading) return;
    setValidationLoading(true);
    setValidationError(null);
    setTab("validation");
    try {
      const triggerResponse = await fetch(`${API_BASE}/drawings/${id}/validate`, { method: "POST" });
      const triggerPayload = await triggerResponse.json();
      if (!triggerResponse.ok) throw new Error(triggerPayload.detail ?? "Validation could not be completed.");
      const [reportResponse, catalogResponse] = await Promise.all([
        fetch(`${API_BASE}/drawings/${id}/validation`),
        fetch(`${API_BASE}/drawings/${id}/validation/rules`),
      ]);
      if (!reportResponse.ok) throw new Error("Validation completed but its persisted report could not be refreshed.");
      setValidation(await reportResponse.json() as ValidationReport);
      if (catalogResponse.ok) {
        setValidationCatalog(await catalogResponse.json() as ValidationRuleMetadata[]);
      }
    } catch (caught) {
      setValidationError(caught instanceof Error ? caught.message : "Validation could not be completed.");
    } finally {
      setValidationLoading(false);
    }
  }

  function selectVisualObject(item: VisualObject) {
    setSelection(null);
    setValidationSelection([]);
    setVisualSelection(item);
    setPage(item.page_number);
  }

  function toggleVisualType(type: VisualObjectType) {
    setVisibleVisualTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function runVision() {
    if (visionLoading) return;
    setVisionLoading(true);
    setVisionError(null);
    setTab("vision");
    try {
      let baseline = validation;
      if (!baseline && !vision) {
        const baselineResponse = await fetch(`${API_BASE}/drawings/${id}/validate`, { method: "POST" });
        const baselinePayload = await baselineResponse.json();
        if (!baselineResponse.ok) {
          throw new Error(baselinePayload.detail ?? "Level-2 baseline validation could not be completed.");
        }
        baseline = baselinePayload as ValidationReport;
        setValidation(baseline);
      }
      if (!preVisionValidation && baseline) setPreVisionValidation(baseline);
      const response = await fetch(`${API_BASE}/drawings/${id}/vision/analyze`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Level-3 analysis could not be completed.");
      setVision(payload as VisionReport);
      const validationResponse = await fetch(`${API_BASE}/drawings/${id}/validate`, { method: "POST" });
      if (validationResponse.ok) setValidation(await validationResponse.json() as ValidationReport);
    } catch (caught) {
      setVisionError(caught instanceof Error ? caught.message : "Level-3 analysis could not be completed.");
    } finally {
      setVisionLoading(false);
    }
  }

  async function runRelationships() {
    if (relationshipLoading) return;
    setRelationshipLoading(true);
    setRelationshipError(null);
    setTab("relationships");
    try {
      const response = await fetch(`${API_BASE}/drawings/${id}/relationships/analyze`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Level-4 relationship analysis could not be completed.");
      setRelationships(payload as RelationshipReport);
      const completeResponse = await fetch(`${API_BASE}/drawings/${id}/report`);
      if (completeResponse.ok) setCompleteReport(await completeResponse.json() as CompleteAnalysisReport);
    } catch (caught) {
      setRelationshipError(caught instanceof Error ? caught.message : "Level-4 relationship analysis could not be completed.");
    } finally {
      setRelationshipLoading(false);
    }
  }

  async function runCompleteAnalysis() {
    if (completeLoading) return;
    setCompleteLoading(true);
    setCompleteError(null);
    setTab("report");
    setCompleteSteps({ level1: "COMPLETE", level2: "RUNNING", level3: "NOT RUN", level4: "NOT RUN", review: "NOT RUN" });
    try {
      const baseValidationResponse = await fetch(`${API_BASE}/drawings/${id}/validate`, { method: "POST" });
      const baseValidationPayload = await baseValidationResponse.json();
      if (!baseValidationResponse.ok) throw new Error(baseValidationPayload.detail ?? "Level-2 validation failed.");
      const baseline = baseValidationPayload as ValidationReport;
      setPreVisionValidation(baseline);
      setValidation(baseline);
      setCompleteSteps((current) => ({ ...current, level2: "COMPLETE", level3: "RUNNING" }));

      const visionResponse = await fetch(`${API_BASE}/drawings/${id}/vision/analyze`, { method: "POST" });
      const visionPayload = await visionResponse.json();
      if (!visionResponse.ok) throw new Error(visionPayload.detail ?? "Level-3 visual analysis failed.");
      setVision(visionPayload as VisionReport);

      const upgradedValidationResponse = await fetch(`${API_BASE}/drawings/${id}/validate`, { method: "POST" });
      const upgradedValidationPayload = await upgradedValidationResponse.json();
      if (!upgradedValidationResponse.ok) throw new Error(upgradedValidationPayload.detail ?? "Post-visual validation failed.");
      setValidation(upgradedValidationPayload as ValidationReport);
      setCompleteSteps((current) => ({ ...current, level3: "COMPLETE", level4: "RUNNING" }));

      const relationshipResponse = await fetch(`${API_BASE}/drawings/${id}/relationships/analyze`, { method: "POST" });
      const relationshipPayload = await relationshipResponse.json();
      if (!relationshipResponse.ok) throw new Error(relationshipPayload.detail ?? "Level-4 relationship analysis failed.");
      setRelationships(relationshipPayload as RelationshipReport);
      setCompleteSteps((current) => ({ ...current, level4: "COMPLETE", review: "RUNNING" }));

      const reportResponse = await fetch(`${API_BASE}/drawings/${id}/report`);
      const reportPayload = await reportResponse.json();
      if (!reportResponse.ok) throw new Error(reportPayload.detail ?? "Final review could not be prepared.");
      setCompleteReport(reportPayload as CompleteAnalysisReport);
      setCompleteSteps({ level1: "COMPLETE", level2: "COMPLETE", level3: "COMPLETE", level4: "COMPLETE", review: "COMPLETE" });
    } catch (caught) {
      setCompleteError(caught instanceof Error ? caught.message : "Complete analysis could not be completed.");
    } finally {
      setCompleteLoading(false);
    }
  }

  const tabContent: Record<AnalysisTab, ReactNode> = {
    overview: <Overview drawing={drawing} currentPage={page} onSelect={selectEvidence} />,
    revisions: <Revisions records={drawing.revision_records ?? []} onSelect={selectEvidence} />,
    notes: <Notes notes={drawing.notes ?? []} onSelect={selectEvidence} />,
    bom: <BomParts drawing={drawing} onSelect={selectEvidence} />,
    supplier: <Supplier supplier={drawing.supplier_info} rasterCount={drawing.supplier_raster_regions.length} onSelect={selectEvidence} />,
    standards: <Standards standards={drawing.standard_references ?? []} onSelect={selectEvidence} />,
    quality: <ExtractionQuality drawing={drawing} />,
    validation: (
      <ValidationPanel
        report={validation}
        beforeVisionReport={preVisionValidation}
        vision={vision}
        loading={validationLoading}
        visionLoading={visionLoading}
        error={validationError}
        drawingId={id}
        catalog={validationCatalog}
        onRun={runValidation}
        onRunVision={runVision}
        onEvidence={selectValidationEvidence}
      />
    ),
    vision: (
      <VisualIntelligencePanel
        report={vision}
        loading={visionLoading}
        error={visionError}
        drawingId={id}
        visibleTypes={visibleVisualTypes}
        onToggleType={toggleVisualType}
        onRun={runVision}
        onSelect={selectVisualObject}
      />
    ),
    relationships: (
      <RelationshipIntelligencePanel
        report={relationships}
        loading={relationshipLoading}
        error={relationshipError}
        drawingId={id}
        onRun={runRelationships}
        onEvidence={selectRelationshipEvidence}
        onEntity={selectRelationshipEntity}
      />
    ),
    report: (
      <FinalReviewPanel
        drawing={drawing}
        validation={validation}
        vision={vision}
        relationships={relationships}
        completeReport={completeReport}
        drawingId={id}
        completeLoading={completeLoading}
        onRunComplete={runCompleteAnalysis}
        onFinding={selectRelationshipEvidence}
      />
    ),
    json: <RawJson drawing={drawing} />,
  };

  const activeNavigation = NAVIGATION.find((group) =>
    group.tabs.some((item) => item.id === tab)
  ) ?? NAVIGATION[0];

  return (
    <main className="analysis-page">
      <div className="analysis-heading">
        <div className="analysis-heading__title">
          <button type="button" className="back-button" onClick={onReset}>← New upload</button>
          <div>
            <span className="document-kicker">Drawing analysis · {drawing.document_type.value?.replaceAll("_", " ") ?? "Unclassified"}</span>
            <h1>{drawing.drawing_number.value ?? drawing.source_filename.value ?? "Untitled drawing"}<span>REV {drawing.revision.value ?? "—"}</span></h1>
            <p>{drawing.part_name.value ?? drawing.source_filename.value}</p>
          </div>
        </div>
        <div className="analysis-heading__actions">
          <div className="summary-stat"><strong>{knownFields}</strong><span>Fields found</span></div>
          <div className="summary-stat"><strong>{drawing.page_count.value ?? drawing.pages?.length ?? 0}</strong><span>Sheets</span></div>
          <button type="button" className="complete-cta" onClick={runCompleteAnalysis} disabled={completeLoading}>
            {completeLoading ? "ANALYSIS RUNNING…" : "RUN COMPLETE ANALYSIS"}
          </button>
          <button
            type="button"
            className="validation-cta debug-action"
            onClick={runValidation}
            disabled={validationLoading}
          >
            {validationLoading ? "VALIDATION RUNNING…" : validation ? "RE-RUN VALIDATION" : "RUN LEVEL 2 VALIDATION"}
          </button>
          <button
            type="button"
            className="vision-cta debug-action"
            onClick={runVision}
            disabled={visionLoading}
          >
            {visionLoading ? "VISUAL ANALYSIS RUNNING…" : vision ? "RE-RUN VISUAL ANALYSIS" : "RUN VISUAL ANALYSIS"}
          </button>
          <a className="export-button" href={`${API_BASE}/drawings/${id}/export/json`}>Export JSON <span>↓</span></a>
        </div>
      </div>

      <div className="execution-state" aria-label="Analysis execution state">
        <span className="execution-state__complete">Level 1 <strong>COMPLETE</strong></span>
        <span className={validationLoading || completeSteps.level2 === "RUNNING" ? "execution-state__running" : validation ? "execution-state__complete" : ""}>
          Level 2 <strong>{validationLoading || completeSteps.level2 === "RUNNING" ? "RUNNING" : validation ? "COMPLETE" : "NOT RUN"}</strong>
        </span>
        <span className={visionLoading || completeSteps.level3 === "RUNNING" ? "execution-state__running" : vision ? "execution-state__complete" : ""}>
          Level 3 <strong>{visionLoading || completeSteps.level3 === "RUNNING" ? "RUNNING" : vision ? "COMPLETE" : "NOT RUN"}</strong>
        </span>
        <span className={relationshipLoading || completeSteps.level4 === "RUNNING" ? "execution-state__running" : relationships ? "execution-state__complete" : ""}>
          Level 4 <strong>{relationshipLoading || completeSteps.level4 === "RUNNING" ? "RUNNING" : relationships ? "COMPLETE" : "NOT RUN"}</strong>
        </span>
      </div>

      {(completeLoading || completeError) && (
        <section className="complete-progress" aria-live="polite">
          <div><span>Preparing PDF</span><strong>✓ COMPLETE</strong></div>
          {([
            ["level1", "Level 1 – Extracting drawing information"],
            ["level2", "Level 2 – Running checklist validation"],
            ["level3", "Level 3 – Detecting visual engineering objects"],
            ["level4", "Level 4 – Building engineering relationships"],
            ["review", "Preparing final review"],
          ] as const).map(([key, label]) => <div className={`complete-progress__${completeSteps[key].toLowerCase().replace(" ", "-")}`} key={key}><span>{label}</span><strong>{completeSteps[key] === "COMPLETE" ? "✓ COMPLETE" : completeSteps[key] === "RUNNING" ? "● RUNNING" : "NOT RUN"}</strong></div>)}
          {completeError && <div className="alert" role="alert">{completeError}</div>}
        </section>
      )}

      {drawing.extraction_warnings.length > 0 && (
        <div className="warning-strip">
          <strong>{drawing.extraction_warnings.length} extraction notice{drawing.extraction_warnings.length === 1 ? "" : "s"}</strong>
          <span>Review Extraction Quality for details.</span>
        </div>
      )}

      <div className="analysis-workspace">
        <PdfPreview
          file={file}
          pages={drawing.pages ?? []}
          currentPage={page}
          selection={selection}
          validationSelection={validationSelection}
          visualObjects={vision?.objects ?? []}
          visualSelection={visualSelection}
          visibleVisualTypes={visibleVisualTypes}
          extractedRegions={locatedFields}
          showExtractedRegions={showExtractedRegions}
          onShowExtractedRegions={setShowExtractedRegions}
          onPageChange={setPage}
          onClearSelection={() => { setSelection(null); setValidationSelection([]); setVisualSelection(null); }}
        />

        <section className="analysis-panel">
          <div className="primary-tabs" role="tablist" aria-label="Analysis levels">
            {NAVIGATION.map((group) => (
              <button type="button" role="tab" aria-selected={activeNavigation.id === group.id} className={activeNavigation.id === group.id ? "primary-tab primary-tab--active" : "primary-tab"} onClick={() => setTab(group.tabs[0].id)} key={group.id}>{group.label}</button>
            ))}
          </div>
          <div className="tabs" role="tablist" aria-label={`${activeNavigation.label} sections`}>
            {activeNavigation.tabs.map((item) => {
              const count =
                item.id === "revisions" ? drawing.revision_records?.length :
                item.id === "notes" ? drawing.notes?.length :
                item.id === "bom" ? (drawing.bom_items?.length ?? 0) + (drawing.part_list_items?.length ?? 0) + (drawing.service_part_items?.length ?? 0) :
                item.id === "supplier" ? (drawing.supplier_info?.supplier_drawing.value ? 1 : 0) :
                item.id === "standards" ? drawing.standard_references?.length :
                item.id === "quality" ? drawing.extraction_warnings.length : undefined;
              const displayCount = item.id === "validation"
                ? validation?.summary.total_rules
                : item.id === "vision"
                  ? vision?.summary.objects_detected
                  : item.id === "relationships"
                    ? relationships?.summary.relationships_checked
                  : count;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={`${tab === item.id ? "tab tab--active" : "tab"} ${item.id === "validation" ? "tab--validation" : ""} ${item.id === "vision" ? "tab--vision" : ""} ${item.id === "relationships" ? "tab--relationships" : ""}`}
                  onClick={() => setTab(item.id)}
                  key={item.id}
                >
                  {item.label}{displayCount !== undefined && <span>{displayCount}</span>}
                </button>
              );
            })}
          </div>
          <div className="analysis-panel__body" role="tabpanel">{tabContent[tab]}</div>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  const [demoMode, setDemoMode] = useState(DEMO_MODE);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DrawingUploadResponse | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/health")
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { demo_mode?: boolean } | null) => {
        if (active && payload?.demo_mode) setDemoMode(true);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  function acceptFile(nextFile?: File) {
    if (!nextFile) return;
    if (!nextFile.name.toLowerCase().endsWith(".pdf")) {
      setError("Select a PDF engineering drawing.");
      return;
    }
    if (nextFile.size > MAX_UPLOAD_BYTES) {
      setError("The PDF exceeds the 50 MB PoC upload limit.");
      return;
    }
    setFile(nextFile);
    setError(null);
  }

  async function upload() {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    setIsUploading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/drawings/upload`, { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "The drawing could not be processed.");
      setResult(payload as DrawingUploadResponse);
      window.history.pushState({}, "", `/drawings/${payload.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The drawing could not be processed.");
    } finally {
      setIsUploading(false);
    }
  }

  function reset() {
    setResult(null);
    setFile(null);
    setError(null);
    window.history.pushState({}, "", "/");
  }

  return (
    <div className={`app-shell ${demoMode ? "demo-mode" : ""}`}>
      <header className="topbar">
        <button type="button" className="brand" onClick={reset} aria-label="Drawing Intelligence home">
          <span className="brand__mark">DI</span>
          <span className="brand__name">Engineering Drawing Intelligence</span>
        </button>
        <div className="topbar__status"><span /> Level 1 extraction · Level 2 validation · Level 3 visual intelligence · Level 4 relationship intelligence</div>
      </header>

      {result && file ? (
        <AnalysisPage id={result.id} file={file} drawing={result.drawing} onReset={reset} />
      ) : (
        <UploadPage
          file={file}
          isDragging={isDragging}
          isUploading={isUploading}
          error={error}
          onFile={acceptFile}
          onDragging={setIsDragging}
          onUpload={upload}
        />
      )}

      <footer className="app-footer">
        <span>Level-1 extraction · Level-2 checklist validation · Level-3 visual intelligence · Level-4 relationship intelligence</span>
        <span>Review assistance only · Final engineering approval remains human.</span>
      </footer>
    </div>
  );
}
