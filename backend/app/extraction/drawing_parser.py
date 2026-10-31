"""Fault-isolated orchestration of the Level-1 drawing extractors."""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from backend.app.extraction.bom import BOMExtractor
from backend.app.extraction.classification import DocumentClassifier
from backend.app.extraction.notes import NotesExtractor
from backend.app.extraction.page_context import (
    DocumentContext,
    PageTemplate,
    build_document_context,
)
from backend.app.extraction.revision_table import RevisionTableExtractor
from backend.app.extraction.standards import StandardsExtractor
from backend.app.extraction.supplier import SupplierInfoExtractor
from backend.app.extraction.supplier_raster import SupplierRasterRegionExtractor
from backend.app.extraction.title_block import TitleBlockExtractor
from backend.app.models.drawing import (
    BOMItem,
    DocumentClassification,
    DocumentType,
    DrawingDocument,
    DrawingNote,
    DrawingPage,
    ExtractedField,
    ExtractionMethod,
    ExtractionWarning,
    Level1Summary,
    ProcessingState,
    RevisionRecord,
    StandardReference,
    SupplierInfo,
    SupplierRasterRegion,
    TableType,
    TitleBlock,
    WarningSeverity,
)

logger = logging.getLogger(__name__)

ResultT = TypeVar("ResultT")
HIGH_CONFIDENCE_THRESHOLD = 0.9


def _unknown() -> ExtractedField:
    return ExtractedField()


def _metadata_field(value: ResultT, method: ExtractionMethod) -> ExtractedField[ResultT]:
    return ExtractedField(
        value=value,
        confidence=1.0,
        extraction_method=method,
    )


def _normalized_field(
    title_blocks: list[TitleBlock],
    field_name: str,
) -> ExtractedField:
    fields = [getattr(title_block, field_name) for title_block in title_blocks]
    known = [field for field in fields if field.value is not None]
    if not known:
        return _unknown()
    if any(field.value != known[0].value for field in known[1:]):
        if field_name in {"scale", "weight", "sheet_number"}:
            if fields and fields[0].value is not None:
                return fields[0].model_copy(deep=True)
            return known[0].model_copy(deep=True)
        return _unknown()
    if len(known) != len(fields) and any(
        field.confidence < HIGH_CONFIDENCE_THRESHOLD for field in known
    ):
        return _unknown()
    return max(known, key=lambda field: field.confidence).model_copy(deep=True)


class DrawingParser:
    """Build a ``DrawingDocument`` while isolating every extraction stage."""

    def __init__(
        self,
        *,
        classifier: DocumentClassifier | None = None,
        title_block_extractor: TitleBlockExtractor | None = None,
        revision_extractor: RevisionTableExtractor | None = None,
        notes_extractor: NotesExtractor | None = None,
        bom_extractor: BOMExtractor | None = None,
        supplier_extractor: SupplierInfoExtractor | None = None,
        standards_extractor: StandardsExtractor | None = None,
        supplier_raster_extractor: SupplierRasterRegionExtractor | None = None,
    ) -> None:
        self.classifier = classifier or DocumentClassifier()
        self.title_block_extractor = title_block_extractor or TitleBlockExtractor()
        self.revision_extractor = revision_extractor or RevisionTableExtractor()
        self.notes_extractor = notes_extractor or NotesExtractor()
        self.bom_extractor = bom_extractor or BOMExtractor()
        self.supplier_extractor = supplier_extractor or SupplierInfoExtractor()
        self.standards_extractor = standards_extractor or StandardsExtractor()
        self.supplier_raster_extractor = (
            supplier_raster_extractor or SupplierRasterRegionExtractor()
        )

    def parse(
        self,
        pdf_path: str | Path,
        *,
        source_filename: str | None = None,
    ) -> DrawingDocument:
        path = Path(pdf_path)
        warnings: list[ExtractionWarning] = []
        context = self._safe(
            "document_inspection",
            lambda: build_document_context(path),
            lambda: DocumentContext(path=path, page_count=0, pages=()),
            warnings,
        )
        self._record_context_warnings(context, warnings)
        classification = self._safe(
            "document_classification",
            lambda: self.classifier.extract(path),
            DocumentClassification,
            warnings,
        )
        title_blocks = self._safe(
            "title_block",
            lambda: self.title_block_extractor.extract(path),
            list,
            warnings,
        )
        revisions = self._safe(
            "revision_table",
            lambda: self.revision_extractor.extract(path),
            list,
            warnings,
        )
        notes = self._safe(
            "notes",
            lambda: self.notes_extractor.extract(path),
            list,
            warnings,
        )
        bom = self._safe(
            "bom",
            lambda: self.bom_extractor.extract(path),
            list,
            warnings,
        )
        supplier = self._safe(
            "supplier_info",
            lambda: self.supplier_extractor.extract(path),
            SupplierInfo,
            warnings,
        )
        standards = self._safe(
            "standards",
            lambda: self.standards_extractor.extract(path),
            list,
            warnings,
        )
        raster_regions = self._safe(
            "supplier_raster_regions",
            lambda: self.supplier_raster_extractor.extract(path, context=context),
            list,
            warnings,
        )
        for page_number in sorted({region.page_number for region in raster_regions}):
            warnings.append(
                ExtractionWarning(
                    stage="supplier_raster_regions",
                    code="SUPPLIER_RASTER_CONTENT_NOT_EXTRACTED",
                    severity=WarningSeverity.INFO,
                    page_number=page_number,
                    message=(
                        "A supplier-original raster region was detected. Its image "
                        "content was not OCR-extracted in Level 1."
                    ),
                )
            )

        if title_blocks and len(title_blocks) != context.page_count:
            warnings.append(
                ExtractionWarning(
                    stage="title_block",
                    code="E02",
                    message=(
                        f"Extractor returned {len(title_blocks)} page result(s) "
                        f"for a {context.page_count}-page document."
                    ),
                )
            )
        if context.page_count and (
            not title_blocks or all(block.drawing_number.value is None for block in title_blocks)
        ):
            warnings.append(
                ExtractionWarning(
                    stage="title_block",
                    code="E02",
                    message="No title-block drawing number was extracted.",
                    field_name="drawing_number",
                )
            )

        document = DrawingDocument(
            source_filename=_metadata_field(
                source_filename or path.name,
                ExtractionMethod.FILE_METADATA,
            ),
            page_count=(
                _metadata_field(context.page_count, ExtractionMethod.PDF_METADATA)
                if context.page_count > 0
                else _unknown()
            ),
            document_type=self._document_type_field(classification),
            drawing_number=_normalized_field(title_blocks, "drawing_number"),
            revision=_normalized_field(title_blocks, "revision"),
            drawing_size=_normalized_field(title_blocks, "drawing_size"),
            part_name=_normalized_field(title_blocks, "part_name"),
            part_numbers=_normalized_field(title_blocks, "part_numbers"),
            units=_normalized_field(title_blocks, "units"),
            scale=_normalized_field(title_blocks, "scale"),
            weight=_normalized_field(title_blocks, "weight"),
            sheet_number=_normalized_field(title_blocks, "sheet_number"),
            total_sheets=_normalized_field(title_blocks, "sheet_count"),
            critical_component=_normalized_field(title_blocks, "critical_component"),
            release_date=_normalized_field(title_blocks, "release_date"),
            drawing_date=_normalized_field(title_blocks, "drawing_date"),
            drawn_by=_normalized_field(title_blocks, "drawn_by"),
            modeled_by=_normalized_field(title_blocks, "modeled_by"),
            approved_by=_normalized_field(title_blocks, "approved_by"),
            revision_records=revisions,
            notes=notes,
            bom_items=[
                item for item in bom if item.table_type in {TableType.BOM, TableType.UNKNOWN}
            ],
            part_list_items=[item for item in bom if item.table_type == TableType.PART_LIST],
            service_part_items=[item for item in bom if item.table_type == TableType.SERVICE_PARTS],
            supplier_info=supplier,
            standard_references=standards,
            pages=self._drawing_pages(
                context,
                title_blocks,
                revisions,
                notes,
                bom,
                standards,
                raster_regions,
            ),
            supplier_raster_regions=raster_regions,
            extraction_warnings=warnings,
        )
        document.level1_summary = self._summary(document)
        logger.info(
            "Parsed %s with %s non-fatal warning(s)",
            path.name,
            len(warnings),
        )
        return document

    def extract(self, pdf_path: str | Path) -> DrawingDocument:
        """Alias for callers that use the extractor naming convention."""
        return self.parse(pdf_path)

    def parse_json(
        self,
        pdf_path: str | Path,
        *,
        source_filename: str | None = None,
        indent: int | None = 2,
    ) -> str:
        return self.parse(
            pdf_path,
            source_filename=source_filename,
        ).model_dump_json(indent=indent)

    @staticmethod
    def _safe(
        stage: str,
        operation: Callable[[], ResultT],
        default_factory: Callable[[], ResultT],
        warnings: list[ExtractionWarning],
    ) -> ResultT:
        try:
            return operation()
        except Exception as exc:
            message = str(exc).strip() or "Extractor failed without an error message."
            warnings.append(
                ExtractionWarning(
                    stage=stage,
                    message=message,
                    exception_type=type(exc).__name__,
                )
            )
            logger.exception("Drawing parser stage %s failed", stage)
            return default_factory()

    @staticmethod
    def _record_context_warnings(
        context: DocumentContext,
        warnings: list[ExtractionWarning],
    ) -> None:
        if context.page_count == 0:
            warnings.append(
                ExtractionWarning(
                    stage="page_text_blocks",
                    code="E09",
                    message="Page text and blocks could not be extracted.",
                )
            )
        for page in context.pages:
            if not page.native_text_available:
                warnings.append(
                    ExtractionWarning(
                        stage="page_text_blocks",
                        page_number=page.page_number,
                        code="E09",
                        message="No native text was extracted from this page.",
                    )
                )
            if page.template == PageTemplate.UNKNOWN:
                warnings.append(
                    ExtractionWarning(
                        stage="page_template",
                        page_number=page.page_number,
                        code="E10",
                        severity=WarningSeverity.INFO,
                        message="Page dimensions do not match a known Club Car template.",
                    )
                )

    @staticmethod
    def _document_type_field(
        classification: DocumentClassification,
    ) -> ExtractedField[str]:
        if classification.document_type == DocumentType.UNKNOWN:
            return _unknown()
        evidence = classification.evidence
        if evidence.value is None:
            return _unknown()
        return ExtractedField(
            value=str(classification.document_type),
            page_number=evidence.page_number,
            confidence=evidence.confidence,
            extraction_method=evidence.extraction_method,
            bounding_box=evidence.bounding_box,
            raw_text=evidence.raw_text,
            evidence_anchor=evidence.evidence_anchor,
        )

    @staticmethod
    def _drawing_pages(
        context: DocumentContext,
        title_blocks: list[TitleBlock],
        revisions: list[RevisionRecord],
        notes: list[DrawingNote],
        bom: list[BOMItem],
        standards: list[StandardReference],
        raster_regions: list[SupplierRasterRegion],
    ) -> list[DrawingPage]:
        pages: list[DrawingPage] = []
        for page_context in context.pages:
            page_number = page_context.page_number
            pages.append(
                DrawingPage(
                    page_number=page_number,
                    width=page_context.width,
                    height=page_context.height,
                    template=str(page_context.template),
                    native_text_available=page_context.native_text_available,
                    word_count=len(page_context.words),
                    text_block_count=len(page_context.blocks),
                    title_block=(
                        title_blocks[page_number - 1] if page_number <= len(title_blocks) else None
                    ),
                    revisions=[record for record in revisions if record.page_number == page_number],
                    notes=[note for note in notes if note.page_number == page_number],
                    bom=[item for item in bom if item.page_number == page_number],
                    standards=[
                        reference
                        for reference in standards
                        if reference.designation.page_number == page_number
                    ],
                    supplier_raster_regions=[
                        region for region in raster_regions if region.page_number == page_number
                    ],
                )
            )
        return pages

    @staticmethod
    def _summary(document: DrawingDocument) -> Level1Summary:
        counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}

        def visit(value: object) -> None:
            if isinstance(value, ExtractedField):
                if value.value is not None:
                    category = str(value.confidence_category)
                    if category in counts:
                        counts[category] += 1
                return
            if isinstance(value, list):
                for item in value:
                    visit(item)
                return
            model_fields = getattr(value.__class__, "model_fields", None)
            if model_fields is not None:
                for field_name in model_fields:
                    if field_name != "level1_summary":
                        visit(getattr(value, field_name))

        visit(document)
        state = (
            ProcessingState.FAILED
            if document.page_count.value is None
            else ProcessingState.SUCCESS_WITH_WARNINGS
            if any(
                warning.severity != WarningSeverity.INFO for warning in document.extraction_warnings
            )
            else ProcessingState.SUCCESS
        )
        return Level1Summary(
            source_filename=str(document.source_filename.value or ""),
            drawing_number=document.drawing_number.value,
            revision=document.revision.value,
            part_name=document.part_name.value,
            document_type=document.document_type.value,
            extracted_field_count=sum(counts.values()),
            high_confidence_count=counts["HIGH"],
            medium_confidence_count=counts["MEDIUM"],
            low_confidence_count=counts["LOW"],
            warning_count=len(document.extraction_warnings),
            supplier_raster_region_count=len(document.supplier_raster_regions),
            processing_state=state,
        )
