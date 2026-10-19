"""Local QR decoding with an optional validated Version 5 pattern-repair fallback."""

import argparse
from collections import defaultdict
import importlib.metadata
import json
from pathlib import Path
import sys

import cv2
import numpy as np
import zxingcpp


def valid_qr_results(image):
    return [
        result
        for result in zxingcpp.read_barcodes(
            image, formats=zxingcpp.BarcodeFormat.QRCode
        )
        if result.valid and result.text and result.format == zxingcpp.BarcodeFormat.QRCode
    ]


def read_image(path):
    image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot read image: {path}")
    return image


def refine_version5_anchors(gray, quad):
    modules = 37
    module_corners = np.array(
        [[0, 0], [modules, 0], [modules, modules], [0, modules]], dtype=np.float32
    )
    projection = cv2.getPerspectiveTransform(module_corners, quad)
    module_centers = np.array(
        [[[3.5, 3.5], [33.5, 3.5], [3.5, 33.5], [30.5, 30.5]]],
        dtype=np.float32,
    )
    expected = cv2.perspectiveTransform(module_centers, projection)[0]
    pitch = np.mean(np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1)) / modules
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 7
    )
    contours, _ = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    anchors = []

    # Match finder-center contours and the alignment ring near projected positions.
    for target in expected:
        candidates = []
        expected_area = pitch**2 * 9
        for index, contour in enumerate(contours):
            center, (width, height), _ = cv2.minAreaRect(contour)
            area = cv2.contourArea(contour)
            distance = np.linalg.norm(np.array(center) - target)
            if (
                distance > 2.5 * pitch
                or min(width, height) <= 0
                or not 0.6 < width / height < 1.6
                or not 0.45 < area / expected_area < 1.7
            ):
                continue
            score = distance / pitch + abs(np.log(area / expected_area))
            candidates.append((score, index, center))
        if not candidates:
            raise ValueError("Cannot refine all Version 5 pattern centers")
        _, _, center = min(candidates)
        anchors.append(center)

    return np.array(anchors, dtype=np.float32), module_centers[0] * 10


def repair_fixed_patterns(grid):
    if grid.shape != (37, 37):
        raise ValueError("This repair diagnostic only supports a 37 x 37 grid")
    repaired = grid.copy()
    for x, y in ((0, 0), (30, 0), (0, 30)):
        repaired[max(0, y - 1) : min(37, y + 8), max(0, x - 1) : min(37, x + 8)] = False
        for row in range(7):
            for col in range(7):
                repaired[y + row, x + col] = (
                    row in (0, 6)
                    or col in (0, 6)
                    or (2 <= row <= 4 and 2 <= col <= 4)
                )
    for index in range(8, 29):
        repaired[6, index] = index % 2 == 0
        repaired[index, 6] = index % 2 == 0
    for row in range(-2, 3):
        for col in range(-2, 3):
            repaired[30 + row, 30 + col] = (
                abs(row) == 2 or abs(col) == 2 or (row == 0 and col == 0)
            )
    repaired[29, 8] = True
    return repaired


def render_grid(grid):
    pixels = np.where(grid, 0, 255).astype(np.uint8)
    pixels = cv2.copyMakeBorder(pixels, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    return cv2.resize(pixels, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)


def repair_version5(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    found, points = cv2.QRCodeDetector().detect(gray)
    if not found:
        raise ValueError("OpenCV could not locate the QR code")
    anchors, target = refine_version5_anchors(gray, points[0].astype(np.float32))
    transform = cv2.getPerspectiveTransform(anchors, target)
    flat = cv2.warpPerspective(gray, transform, (370, 370), borderValue=255)
    variants = [("gray", flat, (80, 100, 120, 140, 160, 180))]
    for block in (15, 25, 35, 51, 71, 101):
        for bias in (0, 3, 7, 13):
            binary = cv2.adaptiveThreshold(
                flat, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, bias
            )
            variants.append((f"adaptive-{block}-{bias}", binary, (128,)))

    successes = defaultdict(list)
    evidence = {}
    coordinates = np.arange(37) * 10 + 5
    attempts = 0
    for label, variant, thresholds in variants:
        for offset_y in (-2, -1, 0, 1, 2):
            for offset_x in (-2, -1, 0, 1, 2):
                samples = variant[np.ix_(coordinates + offset_y, coordinates + offset_x)]
                for threshold in thresholds:
                    grid = repair_fixed_patterns(samples < threshold)
                    rendered = render_grid(grid)
                    attempts += 1
                    for result in valid_qr_results(rendered):
                        if str(result.extra.get("Version")) != "5":
                            continue
                        key = result.bytes
                        successes[key].append(
                            {
                                "preprocessing": label,
                                "offset_x": offset_x,
                                "offset_y": offset_y,
                                "threshold": threshold,
                            }
                        )
                        evidence.setdefault(key, (result, rendered))

    if not successes:
        raise ValueError("Version 5 repair produced no valid QR decode")
    if len(successes) != 1:
        raise ValueError("Repair produced conflicting payloads; refusing to choose")
    payload, parameters = next(iter(successes.items()))
    if len(parameters) < 3:
        raise ValueError("Repair did not produce enough consistent parameter results")
    result, rendered = evidence[payload]
    report = {
        "method": "version5_fixed_pattern_repair",
        "text": result.text,
        "valid": True,
        "format": "QRCode",
        "modules": 37,
        "decoder_metadata": result.extra,
        "anchors": anchors.tolist(),
        "attempts": attempts,
        "consistent_successes": len(parameters),
        "successful_parameters": parameters,
        "format_bits_replaced": False,
        "data_modules_replaced": False,
    }
    return report, rendered, flat


def decode_image(path, allow_repair=False):
    image = read_image(path)
    direct = valid_qr_results(image)
    if direct:
        payloads = sorted({result.text for result in direct})
        return {"method": "direct_zxing_cpp", "texts": payloads, "valid": True}, None, None
    if not allow_repair:
        raise ValueError("Direct QR decode failed; Version 5 repair was not enabled")
    return repair_version5(image)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument(
        "--repair-version5",
        action="store_true",
        help="After direct decoding fails, try fixed-pattern repair; require a valid Version 5 decode and consistent payload",
    )
    parser.add_argument(
        "--diagnostics",
        type=Path,
        help="New private output directory; refuses to overwrite an existing directory",
    )
    args = parser.parse_args()
    try:
        if args.diagnostics and args.diagnostics.exists():
            raise ValueError("Diagnostics directory already exists")
        report, repaired, rectified = decode_image(args.image, args.repair_version5)
        report["image"] = str(args.image.resolve())
        report["dependencies"] = {
            "opencv": cv2.__version__,
            "zxing_cpp": importlib.metadata.version("zxing-cpp"),
        }
        if args.diagnostics:
            args.diagnostics.mkdir(parents=True, exist_ok=False)
            for name, pixels in (
                ("repaired.png", repaired),
                ("rectified.png", rectified),
            ):
                if pixels is not None:
                    ok, encoded = cv2.imencode(".png", pixels)
                    if not ok:
                        raise ValueError(f"Could not encode {name}")
                    encoded.tofile(args.diagnostics / name)
            (args.diagnostics / "decode.json").write_text(
                json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8"
            )
        print(json.dumps(report, ensure_ascii=True))
        return 0
    except (ValueError, OSError, cv2.error) as error:
        print(json.dumps({"valid": False, "error": str(error)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
