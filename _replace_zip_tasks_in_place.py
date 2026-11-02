import binascii
import os
import struct
import sys


ZIP64_EOCD = b"PK\x06\x06"
ZIP64_LOCATOR = b"PK\x06\x07"
EOCD = b"PK\x05\x06"
CENTRAL = b"PK\x01\x02"


def read_exact(handle, size, offset):
    handle.seek(offset)
    data = handle.read(size)
    if len(data) != size:
        raise RuntimeError(f"short read at {offset}: {len(data)} != {size}")
    return data


def find_signature(handle, signature, end, window=1024 * 1024):
    start = max(0, end - window)
    data = read_exact(handle, end - start, start)
    index = data.rfind(signature)
    if index < 0:
        raise RuntimeError(f"signature not found: {signature!r}")
    return start + index


def shift_tail(handle, old_end, delta, old_size):
    new_size = old_size + delta
    handle.truncate(new_size)
    chunk_size = 8 * 1024 * 1024
    position = old_size
    moved = 0
    while position > old_end:
        chunk_start = max(old_end, position - chunk_size)
        size = position - chunk_start
        data = read_exact(handle, size, chunk_start)
        handle.seek(chunk_start + delta)
        handle.write(data)
        position = chunk_start
        moved += size
        if moved >= 1024 * 1024 * 1024:
            print(f"moved {moved / 1024 / 1024 / 1024:.1f} GiB", flush=True)
            moved = 0


def patch_zip64_extra(extra, need_uncompressed, need_compressed, need_offset, values):
    output = bytearray(extra)
    pos = 0
    value_index = 0
    while pos + 4 <= len(output):
        field_id, field_size = struct.unpack_from("<HH", output, pos)
        field_start = pos + 4
        field_end = field_start + field_size
        if field_end > len(output):
            raise RuntimeError("invalid ZIP64 extra field")
        if field_id == 0x0001:
            cursor = field_start
            if need_uncompressed:
                struct.pack_into("<Q", output, cursor, values[value_index])
                cursor += 8
                value_index += 1
            if need_compressed:
                struct.pack_into("<Q", output, cursor, values[value_index])
                cursor += 8
                value_index += 1
            if need_offset:
                struct.pack_into("<Q", output, cursor, values[value_index])
                cursor += 8
                value_index += 1
            return bytes(output)
        pos = field_end
    if need_offset or need_uncompressed or need_compressed:
        raise RuntimeError("ZIP64 extra field is missing")
    return bytes(output)


def read_zip64_extra(extra, need_uncompressed, need_compressed, need_offset):
    pos = 0
    while pos + 4 <= len(extra):
        field_id, field_size = struct.unpack_from("<HH", extra, pos)
        field_start = pos + 4
        field_end = field_start + field_size
        if field_end > len(extra):
            raise RuntimeError("invalid ZIP64 extra field")
        if field_id == 0x0001:
            cursor = field_start
            values = []
            if need_uncompressed:
                values.append(struct.unpack_from("<Q", extra, cursor)[0])
                cursor += 8
            if need_compressed:
                values.append(struct.unpack_from("<Q", extra, cursor)[0])
                cursor += 8
            if need_offset:
                values.append(struct.unpack_from("<Q", extra, cursor)[0])
            return values
        pos = field_end
    raise RuntimeError("ZIP64 extra field is missing")


def patch_central_directory(handle, cd_offset, cd_size, delta, new_crc, new_size):
    data = bytearray(read_exact(handle, cd_size, cd_offset))
    pos = 0
    found_tasks = False
    entries = 0
    while pos < cd_size:
        if data[pos:pos + 4] != CENTRAL:
            raise RuntimeError(f"invalid central directory entry at {cd_offset + pos}")
        entries += 1
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", data, pos + 28)
        record_len = 46 + name_len + extra_len + comment_len
        if pos + record_len > cd_size:
            raise RuntimeError("central directory entry exceeds directory")
        name_start = pos + 46
        name = bytes(data[name_start:name_start + name_len]).decode("utf-8")
        extra_start = name_start + name_len
        extra = bytes(data[extra_start:extra_start + extra_len])

        crc = struct.unpack_from("<I", data, pos + 16)[0]
        compressed = struct.unpack_from("<I", data, pos + 20)[0]
        uncompressed = struct.unpack_from("<I", data, pos + 24)[0]
        local_offset = struct.unpack_from("<I", data, pos + 42)[0]
        need_uncompressed = uncompressed == 0xFFFFFFFF
        need_compressed = compressed == 0xFFFFFFFF
        need_offset = local_offset == 0xFFFFFFFF

        if name == "tasks.json":
            if found_tasks:
                raise RuntimeError("multiple root tasks.json entries")
            found_tasks = True
            struct.pack_into("<I", data, pos + 16, new_crc)
            if need_compressed:
                compressed_value = new_size
            else:
                struct.pack_into("<I", data, pos + 20, new_size)
                compressed_value = new_size
            if need_uncompressed:
                uncompressed_value = new_size
            else:
                struct.pack_into("<I", data, pos + 24, new_size)
                uncompressed_value = new_size
            if extra_len:
                patched = patch_zip64_extra(
                    extra,
                    need_uncompressed,
                    need_compressed,
                    False,
                    [uncompressed_value, compressed_value],
                )
                data[extra_start:extra_start + extra_len] = patched
        else:
            if local_offset != 0xFFFFFFFF:
                updated_offset = local_offset + delta
                if updated_offset >= 0xFFFFFFFF:
                    raise RuntimeError("local offset no longer fits in central directory")
                struct.pack_into("<I", data, pos + 42, updated_offset)
            elif extra_len:
                actual_offset = read_zip64_extra(extra, False, False, True)[0]
                patched = patch_zip64_extra(extra, False, False, True, [actual_offset + delta])
                data[extra_start:extra_start + extra_len] = patched

        pos += record_len

    if pos != cd_size or not found_tasks:
        raise RuntimeError(f"central directory validation failed: pos={pos}, found_tasks={found_tasks}")
    handle.seek(cd_offset + delta)
    handle.write(data)
    return entries


def main(zip_path, replacement_path):
    with open(replacement_path, "rb") as replacement:
        new_data = replacement.read()
    new_size = len(new_data)
    new_crc = binascii.crc32(new_data) & 0xFFFFFFFF

    with open(zip_path, "r+b") as handle:
        archive_size = os.fstat(handle.fileno()).st_size
        local_header = read_exact(handle, 30, 0)
        if local_header[:4] != b"PK\x03\x04":
            raise RuntimeError("tasks.json is not the first ZIP entry")
        name_len, extra_len = struct.unpack_from("<HH", local_header, 26)
        name = read_exact(handle, name_len, 30).decode("utf-8")
        if name != "tasks.json":
            raise RuntimeError(f"first ZIP entry is {name!r}, not tasks.json")
        old_entry_size = struct.unpack_from("<I", local_header, 18)[0]
        old_uncompressed = struct.unpack_from("<I", local_header, 22)[0]
        if old_entry_size != old_uncompressed:
            raise RuntimeError("tasks.json is compressed; refusing in-place replacement")
        old_data_start = 30 + name_len + extra_len
        old_data_end = old_data_start + old_entry_size
        delta = new_size - old_entry_size
        if delta <= 0:
            raise RuntimeError("replacement must be larger than the existing entry for this updater")

        zip64_pos = find_signature(handle, ZIP64_EOCD, archive_size)
        zip64 = read_exact(handle, 56, zip64_pos)
        cd_size = struct.unpack_from("<Q", zip64, 40)[0]
        cd_offset = struct.unpack_from("<Q", zip64, 48)[0]
        if cd_offset + cd_size != zip64_pos:
            raise RuntimeError("unexpected ZIP64 central directory layout")

        print(f"old_size={old_entry_size} new_size={new_size} delta={delta}", flush=True)
        print(f"moving ZIP tail from {old_data_end} to {old_data_end + delta}", flush=True)
        shift_tail(handle, old_data_end, delta, archive_size)

        # Update the first local header and write the replacement payload.
        local = bytearray(read_exact(handle, old_data_start, 0))
        struct.pack_into("<I", local, 14, new_crc)
        struct.pack_into("<I", local, 18, new_size)
        struct.pack_into("<I", local, 22, new_size)
        handle.seek(0)
        handle.write(local)
        handle.seek(old_data_start)
        handle.write(new_data)

        entries = patch_central_directory(
            handle,
            cd_offset,
            cd_size,
            delta,
            new_crc,
            new_size,
        )

        new_cd_offset = cd_offset + delta
        new_zip64_pos = zip64_pos + delta
        zip64 = bytearray(read_exact(handle, 56, new_zip64_pos))
        struct.pack_into("<Q", zip64, 48, new_cd_offset)
        handle.seek(new_zip64_pos)
        handle.write(zip64)

        locator_pos = find_signature(handle, ZIP64_LOCATOR, new_zip64_pos)
        locator = bytearray(read_exact(handle, 20, locator_pos))
        struct.pack_into("<Q", locator, 8, new_zip64_pos)
        handle.seek(locator_pos)
        handle.write(locator)

        print(f"updated entries={entries} crc={new_crc:08x}", flush=True)
        print(f"new_archive_size={archive_size + delta}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: replace_zip_tasks_in_place.py <zip> <replacement tasks.json>")
    main(sys.argv[1], sys.argv[2])
