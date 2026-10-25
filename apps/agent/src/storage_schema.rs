// Frozen v1 schema used by bootstrap and legacy-database fixtures. Future migrations
// must add a new version instead of changing this compatibility definition.
pub const V1_SESSIONS: &str = "CREATE TABLE IF NOT EXISTS sessions (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL,
    state TEXT NOT NULL, summary TEXT NOT NULL, pane_id TEXT,
    updated_at REAL NOT NULL, event_count INTEGER NOT NULL,
    PRIMARY KEY (agent,session_id));";
