"""Read only public Scryfall records from a completed desktop catalog snapshot."""

import pathlib
import sqlite3
import sys

source = pathlib.Path(sys.argv[1]).resolve(strict=True).as_uri() + "?mode=ro&immutable=1"
codes = sys.argv[2:]
sys.stdout.reconfigure(encoding="utf-8")
with sqlite3.connect(source, uri=True) as catalog:
    placeholders = ",".join("?" for _ in codes)
    rows = catalog.execute(
        f"SELECT metadata_json FROM cards WHERE set_code IN ({placeholders})", codes
    )
    for (record,) in rows:
        # Desktop stores compact JSON. Tolerate pretty-printed records as well.
        if "\n" in record or "\r" in record:
            import json
            record = json.dumps(json.loads(record), ensure_ascii=False)
        print(record)
