import { BATCH_ALLOWLIST } from "../../src/lib/batchAllowlist.generated.js";
import { CANARY } from "../../src/lib/canary.js";

// Public test fixture assembled from the Worker allowlists. The original
// one-time migration inventory is intentionally not distributed.
export function createMigrationManifest(){
  const entries = [...BATCH_ALLOWLIST, CANARY].map(entry => ({
    ...entry,
    fileType: entry.key.slice(entry.key.lastIndexOf(".") + 1),
    usedAt: ["public-test-fixture"]
  }));
  return {
    source: { bucket: "your-media-local" },
    target: { bucket: "your-media-staging" },
    totalCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    excludedKeys: [
      "media/other/2099/01/0000000000000001.jpg",
      "media/other/2099/01/0000000000000002.jpg",
      "media/other/2099/01/0000000000000003.jpg",
      "media/other/2099/01/0000000000000004.jpg",
      "media/other/2099/01/0000000000000005.jpg"
    ],
    entries
  };
}

export const MIGRATION_MANIFEST = createMigrationManifest();
