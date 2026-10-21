// Writes data/export.jsonl. Run with `npm run export [-- <username> ...]`. No usernames means all users.

import { DEFAULT_DB_PATH, SqliteStore } from "../store";
import { DEFAULT_EXPORT_PATH, writeExport } from "./export";

const usernames = process.argv.slice(2);
const store = new SqliteStore(DEFAULT_DB_PATH);
try {
  const userIds = usernames.length
    ? usernames.map((name) => {
        const id = store.findUser(name);
        if (!id) throw new Error(`unknown user: ${name}`);
        return id;
      })
    : store.users();
  const count = writeExport(store, userIds, DEFAULT_EXPORT_PATH);
  console.log(`Wrote ${count} row(s) to ${DEFAULT_EXPORT_PATH}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  store.close();
}
