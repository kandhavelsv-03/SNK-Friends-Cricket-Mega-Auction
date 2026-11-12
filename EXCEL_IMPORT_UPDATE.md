# Excel Import improvements

- Uses one database read to collect existing normalized player names instead of querying MongoDB once per row.
- Deduplicates names within the uploaded workbook and against existing MongoDB players (case-insensitive, trimmed names).
- Inserts new players in batches and allocates numeric IDs in one counter update to reduce import time.
- Shows upload percentage, server-side processing status, completion totals, and errors in the Import page.
- Disables the Import button while an upload is in progress to prevent accidental double submissions.
- Supports `.xlsx` and `.xls` uploads up to 25 MB.
- Reports new players, existing database names skipped, duplicate workbook names skipped, invalid rows skipped, and team codes added/already present.

The uploaded workbook contains 671 player rows and one repeated normalized player name (`Ashwani Kumar`). The importer will add at most one copy of that name from the workbook, and will skip it too if it already exists in MongoDB.
