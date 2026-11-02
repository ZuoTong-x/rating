# ZIP Task Format

The ZIP root may contain these two optional JSON files:

- `manifest.json`: image metadata. Each image is matched by `src_rel_path`
  first, then by filename for legacy packages; a missing manifest or unmatched
  row does not block the import.
- `tasks.json`: task definitions. When present, projects created from this
  package import these exact task groups instead of generating random groups.

Images can be stored in any directory. Every image file is imported. A directory
named `信息图` still marks its images as infographic images. `tasks.json` and
`manifest.json` must be placed at the ZIP root.

## tasks.json

Use `docs/tasks.example.json` as a starting point.

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "overall-0001",
      "criterion": "overall",
      "images": [
        "目录1/a.png",
        { "src_rel_path": "目录2/b.png", "role": "target" }
      ]
    }
  ]
}
```

Rules:

- Each `id` is unique within the ZIP.
- `criterion` must be one of:
  `overall`, `creativity`, `mood`, `composition`, `color`, `saturation`, `lighting`,
  `realism`, `detail`, `promptAlignment`, `textCorrectness`,
  `anatomyNormality`, `informationClarity`, `designQuality`, `typography`,
  `highInfoAes`.
- `images` contains 1 to 5 unique image references. The `saturation` criterion
  must contain exactly 2 images. Use the ZIP relative path
  when possible, such as `目录1/a.png`, or an object with `src_rel_path` and an
  optional `role`. `originalPath` and `path` are also accepted. A plain filename
  remains supported for legacy packages, but it must be unique across the ZIP.
- Valid roles are `target`, `filler`, `anchor_low`, `anchor_high`, and
  `boundary`; omit it to use `target`.
- Every task image reference must resolve to exactly one imported image. Invalid
  task JSON rejects the ZIP import and leaves no package record behind.

At project start, the platform copies all imported task templates. The admin
selects one or more teams, then assigns a task count to each scorer. Any
remaining tasks stay unassigned until they are allocated later. The platform
does not change groups, task dimensions, or item order from `tasks.json`.
