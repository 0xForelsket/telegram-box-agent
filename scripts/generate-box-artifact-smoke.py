from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "box-artifact-smoke.pdf"


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.drawCentredString(A4[0] / 2, 12 * mm, f"Artifact gateway smoke test - Page {document.page}")
    canvas.restoreState()


def build_pdf():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        rightMargin=22 * mm,
        leftMargin=22 * mm,
        topMargin=20 * mm,
        bottomMargin=22 * mm,
        title="Box Artifact Delivery Smoke Test",
        author="Telegram Box Agent",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "SmokeTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=27,
        textColor=colors.HexColor("#0F172A"),
        alignment=TA_CENTER,
        spaceAfter=9 * mm,
    )
    body = ParagraphStyle(
        "SmokeBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=16,
        textColor=colors.HexColor("#334155"),
    )
    section = ParagraphStyle(
        "SmokeSection",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=17,
        textColor=colors.HexColor("#1D4ED8"),
        spaceBefore=7 * mm,
        spaceAfter=3 * mm,
    )

    story = [
        Paragraph("Box Artifact Delivery", title),
        Paragraph(
            "This generated PDF verifies that a Box job can produce a real document for private R2 storage, "
            "Telegram delivery, and a signed 24-hour download link.",
            body,
        ),
        Paragraph("Verified contract", section),
    ]
    rows = [
        ["Stage", "Expected result"],
        ["Generate", "A valid, readable PDF is written in the Box workspace."],
        ["Authorize", "The Box receives one short-lived upload token for this object."],
        ["Store", "The Worker streams the object into a private, job-scoped R2 key."],
        ["Deliver", "Telegram receives the document and a signed 24-hour link."],
        ["Retain", "R2 removes the object after 30 days through a lifecycle rule."],
    ]
    table = Table(rows, colWidths=[38 * mm, 112 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1E3A8A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("LEADING", (0, 0), (-1, -1), 13),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.extend([
        table,
        Spacer(1, 8 * mm),
        Paragraph(
            "Smoke marker: BOX_ARTIFACT_PDF_OK. The marker is intentionally extractable so automated checks can "
            "confirm that the final file is not empty or corrupted.",
            body,
        ),
    ])
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    build_pdf()
