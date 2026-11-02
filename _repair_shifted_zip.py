import binascii
import os
import struct
import sys

from _replace_zip_tasks_in_place import (
    ZIP64_EOCD,
    ZIP64_LOCATOR,
    find_signature,
    patch_central_directory,
    read_exact,
)


def main(zip_path, replacement_path, old_entry_size):
    with open(replacement_path, "rb") as replacement:
        new_data = replacement.read()
    new_size = len(new_data)
    delta = new_size - old_entry_size
    new_crc = binascii.crc32(new_data) & 0xFFFFFFFF

    with open(zip_path, "r+b") as handle:
        archive_size = os.fstat(handle.fileno()).st_size
        zip64_pos = find_signature(handle, ZIP64_EOCD, archive_size)
        zip64 = bytearray(read_exact(handle, 56, zip64_pos))
        cd_size = struct.unpack_from("<Q", zip64, 40)[0]
        old_cd_offset = struct.unpack_from("<Q", zip64, 48)[0]
        new_cd_offset = zip64_pos - cd_size
        if new_cd_offset != old_cd_offset + delta:
            raise RuntimeError(
                f"unexpected central directory offset: old={old_cd_offset}, new={new_cd_offset}, delta={delta}"
            )

        entries = patch_central_directory(
            handle,
            new_cd_offset,
            cd_size,
            delta,
            new_crc,
            new_size,
        )

        struct.pack_into("<Q", zip64, 48, new_cd_offset)
        handle.seek(zip64_pos)
        handle.write(zip64)

        locator_pos = find_signature(handle, ZIP64_LOCATOR, zip64_pos)
        locator = bytearray(read_exact(handle, 20, locator_pos))
        struct.pack_into("<Q", locator, 8, zip64_pos)
        handle.seek(locator_pos)
        handle.write(locator)

        print(f"repaired entries={entries} crc={new_crc:08x} size={archive_size}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: repair_shifted_zip.py <zip> <replacement tasks.json> <old entry size>")
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]))
