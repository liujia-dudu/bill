import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "data" / "samples"
SPEC = importlib.util.spec_from_file_location("decode_qr", ROOT / "tools" / "decode_qr.py")
decoder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(decoder)

T2_AVAILABLE = (SAMPLES / "t2" / "input.jpg").is_file()
T3_AVAILABLE = (SAMPLES / "t3" / "input.jpg").is_file()
CATALOG_AVAILABLE = (SAMPLES / "invoice-cases.json").is_file()


class DecodeQrTests(unittest.TestCase):
    def test_synthetic_qr_uses_direct_decode(self):
        payload = "https://example.invalid/invoice?order=synthetic"
        pixels = np.asarray(
            zxingcpp.write_barcode(
                zxingcpp.BarcodeFormat.QRCode, payload, width=300, height=300
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "synthetic.png"
            ok, encoded = decoder.cv2.imencode(".png", pixels)
            self.assertTrue(ok)
            encoded.tofile(filename)
            report, repaired, rectified = decoder.decode_image(filename)
        self.assertEqual(report["texts"], [payload])
        self.assertEqual(report["method"], "direct_zxing_cpp")
        self.assertIsNone(repaired)
        self.assertIsNone(rectified)

    def test_repair_preserves_data_and_format_cells(self):
        source = np.random.default_rng(0).integers(0, 2, size=(37, 37)).astype(bool)
        original = source.copy()
        repaired = decoder.repair_fixed_patterns(source)
        fixed = np.zeros((37, 37), dtype=bool)
        for x, y in ((0, 0), (30, 0), (0, 30)):
            fixed[max(0, y - 1) : min(37, y + 8), max(0, x - 1) : min(37, x + 8)] = True
        fixed[6, 8:29] = True
        fixed[8:29, 6] = True
        fixed[28:33, 28:33] = True
        fixed[29, 8] = True
        np.testing.assert_array_equal(repaired[~fixed], source[~fixed])
        np.testing.assert_array_equal(source, original)

    def test_repair_rejects_other_grid_sizes(self):
        with self.assertRaises(ValueError):
            decoder.repair_fixed_patterns(np.zeros((33, 33), dtype=bool))

    def test_invalid_and_non_qr_results_are_rejected(self):
        results = [
            SimpleNamespace(valid=False, text="bad", format=zxingcpp.BarcodeFormat.QRCode),
            SimpleNamespace(valid=True, text="5753", format=zxingcpp.BarcodeFormat.ITF),
            SimpleNamespace(valid=True, text="", format=zxingcpp.BarcodeFormat.QRCode),
        ]
        with patch.object(zxingcpp, "read_barcodes", return_value=results) as read:
            self.assertEqual(decoder.valid_qr_results(np.zeros((10, 10), dtype=np.uint8)), [])
        self.assertEqual(read.call_args.kwargs["formats"], zxingcpp.BarcodeFormat.QRCode)

    @unittest.skipUnless(T2_AVAILABLE, "Private local t2 sample is not distributed")
    def test_normal_sample_uses_direct_decode(self):
        with patch.object(decoder, "repair_version5") as repair:
            report, repaired, rectified = decoder.decode_image(
                SAMPLES / "t2" / "input.jpg", allow_repair=True
            )
            repair.assert_not_called()
        self.assertEqual(report["method"], "direct_zxing_cpp")
        self.assertTrue(report["texts"][0].startswith("https://invoice.keruyun.com/precode?"))
        self.assertIsNone(repaired)
        self.assertIsNone(rectified)

    @unittest.skipUnless(T3_AVAILABLE, "Private local t3 sample is not distributed")
    def test_t3_repair_requires_opt_in(self):
        with self.assertRaises(ValueError):
            decoder.decode_image(SAMPLES / "t3" / "input.jpg")

    @unittest.skipUnless(
        T3_AVAILABLE and CATALOG_AVAILABLE, "Private local t3 sample is not distributed"
    )
    def test_t3_repaired_payload_and_metadata(self):
        report, repaired, _ = decoder.decode_image(SAMPLES / "t3" / "input.jpg", allow_repair=True)
        catalog = json.loads((SAMPLES / "invoice-cases.json").read_text(encoding="utf-8"))
        case = next(item for item in catalog["cases"] if item["id"] == "t3")
        expected = next(item["original_url"] for item in case["qr_candidates"] if item["decode_valid"])
        self.assertEqual(report["text"], expected)
        self.assertGreaterEqual(report["consistent_successes"], 3)
        self.assertEqual(str(report["decoder_metadata"]["Version"]), "5")
        self.assertEqual(report["decoder_metadata"]["ECLevel"], "L")
        self.assertEqual(report["decoder_metadata"]["DataMask"], 0)
        self.assertFalse(report["data_modules_replaced"])
        self.assertFalse(report["format_bits_replaced"])
        self.assertEqual(decoder.valid_qr_results(repaired)[0].text, report["text"])

    @unittest.skipUnless(T3_AVAILABLE, "Private local t3 sample is not distributed")
    def test_repair_rejects_conflicting_payloads(self):
        a = SimpleNamespace(bytes=b"a", text="a", extra={"Version": "5"})
        b = SimpleNamespace(bytes=b"b", text="b", extra={"Version": "5"})
        with patch.object(decoder, "valid_qr_results", side_effect=[[a], [b]] + [[]] * 748):
            with self.assertRaisesRegex(ValueError, "conflicting payloads"):
                decoder.repair_version5(decoder.read_image(SAMPLES / "t3" / "input.jpg"))

    @unittest.skipUnless(T3_AVAILABLE, "Private local t3 sample is not distributed")
    def test_repair_rejects_insufficient_consistent_results(self):
        result = SimpleNamespace(bytes=b"a", text="a", extra={"Version": "5"})
        with patch.object(
            decoder, "valid_qr_results", side_effect=[[result], [result]] + [[]] * 748
        ):
            with self.assertRaisesRegex(ValueError, "enough consistent"):
                decoder.repair_version5(decoder.read_image(SAMPLES / "t3" / "input.jpg"))

    @unittest.skipUnless(T3_AVAILABLE, "Private local t3 sample is not distributed")
    def test_repair_rejects_other_qr_versions(self):
        result = SimpleNamespace(bytes=b"a", text="a", extra={"Version": "4"})
        with patch.object(decoder, "valid_qr_results", return_value=[result]):
            with self.assertRaisesRegex(ValueError, "no valid QR decode"):
                decoder.repair_version5(decoder.read_image(SAMPLES / "t3" / "input.jpg"))


if __name__ == "__main__":
    unittest.main()
