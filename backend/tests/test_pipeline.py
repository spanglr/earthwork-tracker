"""Pipeline checks.  Run with:  npm run test:python"""
import json
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
os.environ["EARTHWORK_DATA"] = tempfile.mkdtemp(prefix="earthwork-test-")
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import demo  # noqa: E402
import extract  # noqa: E402
import make_practice_plan  # noqa: E402
import pdfgeom  # noqa: E402
import projects  # noqa: E402
import strokefont  # noqa: E402

SHEET = os.path.join(ROOT, "source-pdf", "rhythm-square-zba.pdf")


@unittest.skipUnless(os.path.exists(SHEET), "source PDF not present")
class RhythmSquareSheet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = pdfgeom.open_document(SHEET)
        cls.paths = pdfgeom.load_paths(cls.doc[2])
        cls.project = demo.build(force=True)

    def test_page_is_vector_with_no_raster_and_no_numeric_text(self):
        s = pdfgeom.page_summary(self.doc, 2)
        self.assertEqual(s["kind"], "vector")
        self.assertEqual(s["images"], [])
        self.assertGreater(s["vectorPaths"], 15000)
        # elevation labels are stroked lettering, not text objects
        words = [w["text"] for w in pdfgeom.text_words(self.doc[2])]
        self.assertFalse(any(w in ("995", "990", "985", "980", "975", "970") for w in words))
        self.assertIn("C-2.1", " ".join(words))

    def test_scale_bar_matches_printed_scale(self):
        cal = self.project["calibration"]
        self.assertAlmostEqual(math.dist(cal["a"], cal["b"]), 288.0, places=2)   # 40 ft on the bar
        self.assertAlmostEqual(cal["feetPerPoint"], 10 / 72, places=6)            # 1 inch = 10 ft

    def test_dash_gap_is_detected_for_both_contour_styles(self):
        rows = {r["key"]: r for r in pdfgeom.style_table(self.paths)}
        for key in demo.load_config()["extraction"]["roles"]:
            self.assertAlmostEqual(rows[key]["dashGapPt"], 9.0, delta=0.3)

    def test_stroked_labels_are_read(self):
        labels = strokefont.find_number_labels(self.paths)
        italic = sorted(l["text"] for l in labels if l["italic"] and l["style"] == "rgb(0,0,0)/w0.48")
        self.assertEqual(italic, sorted(["995"] * 4 + ["990"] * 2 + ["985"] * 2 + ["980"] * 3 + ["975"] * 4 + ["970"]))
        upright = {l["text"] for l in labels if not l["italic"] and l["style"] == "rgb(0,0,0)/w0.48"}
        self.assertTrue({"991", "992", "993", "994", "995", "996", "997", "998"} <= upright)

    def test_every_index_contour_piece_has_a_printed_label_or_a_consistent_count(self):
        idx = [c for c in self.project["contours"] if c["kind"] == "index" and c["origin"] == "vector"]
        self.assertGreaterEqual(len(idx), 14)
        for c in idx:
            self.assertIsNotNone(c["auto"]["elevation"])
            self.assertEqual(c["auto"]["elevation"] % 5, 0)
        self.assertEqual(sum(1 for c in idx if c["auto"]["source"] == "label"), 14)

    def test_inferred_heights_are_exact_counts(self):
        for c in self.project["contours"]:
            a = c["auto"]
            if a and a["source"] == "inferred":
                self.assertGreaterEqual(a["inference"]["agree"], 2)
                self.assertGreaterEqual(a["inference"]["agree"] / a["inference"]["votes"], 0.7)

    def test_existing_and_proposed_are_kept_apart(self):
        proposed = [c for c in self.project["contours"] if c["surface"] == "proposed"]
        self.assertEqual(len(proposed), 5)
        self.assertTrue(all(c["origin"] == "adopted" for c in proposed))

    def test_rebuilding_reproduces_the_same_geometry_and_review(self):
        again = demo.build(force=True)
        strip = lambda p: json.dumps([p["contours"], p["calibration"], p["checkPoints"], p["ditches"], p["tickets"]], sort_keys=True)
        self.assertEqual(strip(again), strip(self.project))

    def test_rerunning_extraction_keeps_review_decisions(self):
        p = projects.load(demo.DEMO_ID)
        before = {c["id"]: c["review"] for c in p["contours"]}
        p = projects.run_extraction(p, p["extraction"]["config"])
        self.assertEqual({c["id"]: c["review"] for c in p["contours"]}, before)


class PracticeSheet(unittest.TestCase):
    """A different sheet: solid lines, real PDF text labels, 2 ft interval, 1 in = 20 ft."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="earthwork-practice-")
        make_practice_plan.build(cls.dir)

    def test_text_labels_and_counting(self):
        pdf = os.path.join(self.dir, "practice-plan.pdf")
        paths = pdfgeom.load_paths(pdfgeom.open_document(pdf)[0])
        brown = sorted({p.style for p in paths if p.color[0] > 0.5 and p.color[2] < 0.3})
        self.assertEqual(len(brown), 2)
        thick = max(brown, key=lambda k: float(k.split("/w")[1]))
        thin = min(brown, key=lambda k: float(k.split("/w")[1]))
        res = extract.run_extraction(pdf, 0, {"interval": 2, "indexInterval": 10, "feetPerPoint": 20 / 72,
                                              "roles": {thick: "existing-index", thin: "existing-intermediate"}, "elevationRange": [90, 130]})
        got = sorted((c["auto"]["elevation"], c["auto"]["source"]) for c in res["contours"])
        self.assertEqual(got, [(100, "label"), (102, "inferred"), (104, "inferred"), (106, "inferred"), (108, "inferred"), (110, "label"),
                               (112, "inferred"), (114, "inferred"), (116, "inferred"), (118, "inferred"), (120, "label")])
        self.assertEqual(res["report"]["labelsFromPdfText"], 3)
        self.assertEqual(len(res["marks"]), 2)

    def test_practice_demo_builds_without_any_third_party_file(self):
        p = demo.build(force=True, name="practice")
        self.assertEqual(p["id"], "practice-demo")
        self.assertEqual(sum(1 for c in p["contours"] if c["review"]["status"] == "accepted"), 11)
        self.assertEqual(len(p["tickets"]), 3)
        self.assertEqual([d["id"] for d in p["ditches"]], ["D-01", "D-02", "D-03"])
        # check points were snapped onto the printed tick marks
        for cp in p["checkPoints"]:
            self.assertIn([cp["x"], cp["y"]], p["marks"])
        self.assertTrue(any(d["id"] == "practice-demo" and d["sourcePresent"] for d in demo.status()))

    def test_scan_is_recognised_as_raster(self):
        doc = pdfgeom.open_document(os.path.join(self.dir, "practice-scan.png"))
        s = pdfgeom.page_summary(doc, 0)
        self.assertEqual(s["kind"], "raster")
        self.assertEqual(s["vectorPaths"], 0)

    def test_project_roundtrip_for_a_scan(self):
        p = projects.create("Scan test", os.path.join(self.dir, "practice-scan.png"), "practice-scan.png")
        p = projects.set_page(p, 1)
        self.assertTrue(os.path.exists(os.path.join(projects.pdir(p["id"]), p["source"]["underlay"]["file"])))
        self.assertEqual(projects.load(p["id"])["source"]["kind"], "image")


if __name__ == "__main__":
    unittest.main()
