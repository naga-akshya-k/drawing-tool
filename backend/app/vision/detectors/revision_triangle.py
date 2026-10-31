"""Rule-based revision-triangle and table-triangle detector."""

from __future__ import annotations

import time

import cv2

from backend.app.vision.detectors.base import DetectorContext, VisualDetector, nearby_native_text
from backend.app.vision.models import DetectorResult, VisualObject, VisualObjectType
from backend.app.vision.preprocessing import edge_detection
from backend.app.vision.spatial import intersection_over_union


class RevisionTriangleDetector(VisualDetector):
    name = "revision_triangle"

    def detect(self, context: DetectorContext) -> DetectorResult:
        started = time.perf_counter()
        objects: list[VisualObject] = []
        for page_number in range(1, context.renderer.page_count + 1):
            page = context.renderer.render_page(page_number)
            edges = edge_detection(page.image)
            contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            page_area = page.pdf_width * page.pdf_height
            for contour in contours:
                perimeter = cv2.arcLength(contour, True)
                if perimeter <= 0:
                    continue
                polygon = cv2.approxPolyDP(contour, 0.035 * perimeter, True)
                if len(polygon) != 3 or not cv2.isContourConvex(polygon):
                    continue
                x, y, width, height = cv2.boundingRect(polygon)
                pdf_box = page.pixel_to_pdf_bbox((x, y, x + width, y + height))
                pdf_width = pdf_box[2] - pdf_box[0]
                pdf_height = pdf_box[3] - pdf_box[1]
                area = abs(cv2.contourArea(contour)) / (page.x_scale * page.y_scale)
                if not (5 <= pdf_width <= 45 and 5 <= pdf_height <= 45):
                    continue
                if area / max(pdf_width * pdf_height, 1) < 0.22 or area > page_area * 0.002:
                    continue

                # Classify location: Table / Metadata vs Drawing area
                is_title_block = pdf_box[0] > page.pdf_width * 0.68 and pdf_box[1] > page.pdf_height * 0.82
                is_rev_table = pdf_box[0] < page.pdf_width * 0.40 and pdf_box[1] > page.pdf_height * 0.85
                is_notes_table = pdf_box[0] < page.pdf_width * 0.40 and pdf_box[1] < page.pdf_height * 0.35
                is_bom_table = pdf_box[0] > page.pdf_width * 0.65 and pdf_box[1] < page.pdf_height * 0.30
                is_table = is_title_block or is_rev_table or is_notes_table or is_bom_table

                if not is_table:
                    # In drawing views, geometric lines, fillets, and leader arrows must NOT
                    # be detected. Only true revision triangles containing a revision letter/code
                    # strictly inside the triangle boundary are accepted.
                    text, _ = nearby_native_text(page, pdf_box, margin=1.5, pattern=r"^[A-Z0-9]{1,2}$")
                    if not text:
                        continue
                    label = text
                else:
                    text, _ = nearby_native_text(page, pdf_box, margin=8.0, pattern=r"[A-Z0-9]{1,4}")
                    if is_title_block or is_notes_table:
                        near_words = [
                            w.text.upper()
                            for w in page.native_words
                            if abs(w.bounding_box[0] - pdf_box[0]) < 80 and abs(w.bounding_box[1] - pdf_box[1]) < 35
                        ]
                        if any("CRITICAL" in nw or "SAFETY" in nw or "COMPONENT" in nw for nw in near_words):
                            label = "CRITICAL"
                        else:
                            label = text or ("TABLE_TRIANGLE" if is_title_block else "NOTE_TRIANGLE")
                    elif is_rev_table:
                        label = text or "REV"
                    elif is_bom_table:
                        label = text or "BOM_TRIANGLE"
                    else:
                        label = text or "TABLE_TRIANGLE"

                confidence = min(0.97, 0.88 + (0.08 if label else 0.0))
                points = [
                    (float(point[0][0]) / page.x_scale, float(point[0][1]) / page.y_scale)
                    for point in polygon
                ]
                candidate = VisualObject(
                    object_type=VisualObjectType.REVISION_TRIANGLE,
                    page_number=page_number,
                    bounding_box=pdf_box,
                    polygon=points,
                    confidence=confidence,
                    detector=self.name,
                    raw_text=label,
                    normalized_text=label.upper() if label else None,
                    linked_text=label,
                    attributes={
                        "candidate_revision_identifier": label,
                        "shape": "triangle",
                        "location": "table" if is_table else "drawing",
                    },
                )
                if not any(
                    intersection_over_union(candidate.bounding_box, existing.bounding_box) > 0.65
                    for existing in objects
                    if existing.page_number == page_number
                ):
                    objects.append(candidate)
        return DetectorResult(
            detector_name=self.name,
            objects=objects,
            execution_time_ms=(time.perf_counter() - started) * 1000,
        )
