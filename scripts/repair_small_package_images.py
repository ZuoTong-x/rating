import argparse
import io
import json
import os
import zipfile

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    repaired = []
    with zipfile.ZipFile(args.source, "r") as source, zipfile.ZipFile(
        args.output, "w", compression=zipfile.ZIP_STORED, allowZip64=False
    ) as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename.lower().endswith((".jpg", ".jpeg")) and data.startswith(b"BM"):
                image = Image.open(io.BytesIO(data)).convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=95)
                data = output.getvalue()
                repaired.append(info.filename)
            target.writestr(info.filename, data)

    if not repaired:
        raise RuntimeError("No mislabeled BMP image was found")
    if os.path.getsize(args.output) >= 2_000_000_000:
        raise RuntimeError("Repaired package is not smaller than 2GB")
    print(json.dumps({"repaired": repaired, "bytes": os.path.getsize(args.output)}))


if __name__ == "__main__":
    main()
