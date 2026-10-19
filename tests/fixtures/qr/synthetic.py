"""Generate an in-memory synthetic QR image; never use private invoice samples."""

import sys

import cv2
import numpy as np
import zxingcpp


def main():
    image = np.asarray(
        zxingcpp.write_barcode(
            zxingcpp.BarcodeFormat.QRCode,
            "https://example.invalid/invoice?order=synthetic",
            width=300,
            height=300,
        )
    )
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise ValueError("Cannot encode synthetic QR")
    sys.stdout.buffer.write(encoded.tobytes())


if __name__ == "__main__":
    main()
