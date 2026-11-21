"""Make two small practice files for trying the new-project flow:

  samples/practice-plan.pdf   vector sheet with real text labels, 1 inch = 20 ft,
                              2 ft contours with index lines every 10 ft
  samples/practice-scan.png   the same sheet as a picture (stands in for a scan)

The terrain is invented.  These files are for practice and for the tests only.
"""
import math
import os
import sys

import fitz

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PT_PER_FT = 72 / 20.0
BROWN = (0.55, 0.35, 0.2)


def contour_y(e: float, x: float) -> float:
    return 70 + (e - 100) * 21 + 13 * math.sin(x / 105 + e * 0.15)


def build(out_dir: str = os.path.join(ROOT, "samples")) -> None:
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open()
    page = doc.new_page(width=792, height=612)
    page.insert_text((60, 40), "PRACTICE PLAN - invented terrain, not a real site", fontsize=13)
    for e in range(100, 122, 2):
        pts = [fitz.Point(x, contour_y(e, x)) for x in range(60, 735, 5)]
        index = e % 10 == 0
        page.draw_polyline(pts, color=BROWN, width=1.4 if index else 0.6)
        if index:
            page.insert_text((396, contour_y(e, 405) - 2.5), str(e), fontsize=8, color=BROWN)
    # spot elevations with + marks
    for x, e in ((200, 107.4), (560, 113.2)):
        y = contour_y(e, x)
        page.draw_line((x - 3, y), (x + 3, y), width=0.5)
        page.draw_line((x, y - 3), (x, y + 3), width=0.5)
        page.insert_text((x + 5, y - 3), "%.1f" % e, fontsize=7)
    # graphic scale: 100 ft
    y = 572
    page.draw_line((60, y), (60 + 100 * PT_PER_FT, y), width=1.2)
    for ft in (0, 50, 100):
        x = 60 + ft * PT_PER_FT
        page.draw_line((x, y - 5), (x, y + 5), width=1.2)
        page.insert_text((x - 4, y - 8), "%d ft" % ft if ft else "0", fontsize=7)
    page.insert_text((60, 596), "GRAPHIC SCALE   1 inch = 20 ft     CONTOUR INTERVAL 2 FT", fontsize=8)
    pdf = os.path.join(out_dir, "practice-plan.pdf")
    doc.save(pdf)
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(150 / 72, 150 / 72), colorspace=fitz.csGRAY)
    pix.save(os.path.join(out_dir, "practice-scan.png"))
    print("wrote", pdf, "and practice-scan.png")


if __name__ == "__main__":
    build(*sys.argv[1:2])
