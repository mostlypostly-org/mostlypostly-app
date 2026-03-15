// migrations/032_feature_requests.js
// Feature request system: salons submit ideas, vote on others, track status.
// Staff reviews in Platform Console. Planned/Live items feed the public roadmap.
export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_requests (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      submitted_by TEXT NOT NULL,   -- salon_id
      status       TEXT NOT NULL DEFAULT 'submitted',
      -- status: submitted | under_review | planned | live | declined
      public       INTEGER NOT NULL DEFAULT 0,  -- 1 = show on public roadmap
      vote_count   INTEGER NOT NULL DEFAULT 1,  -- includes submitter's own vote
      staff_notes  TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_request_votes (
      id                 TEXT PRIMARY KEY,
      feature_request_id TEXT NOT NULL REFERENCES feature_requests(id),
      salon_id           TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      UNIQUE(feature_request_id, salon_id)
    )
  `);

  console.log("[032] Created feature_requests and feature_request_votes tables");
}
