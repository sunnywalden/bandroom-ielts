declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ANALYSIS_SIGNING_KEY?: string;
    ANALYSIS_BUNDLE_VERSION?: string;
    ANALYSIS_RUNTIME_BUNDLE_SHA256?: string;
    ANALYSIS_RELEASED_VERSIONS?: string;
    BANDROOM_PUBLIC_ORIGIN?: string;
    // Backup manifest / recording-ticket HMAC key (app/api/backup/handler.ts).
    // Must match the key that signed any backup being restored (design D-11).
    BANDROOM_BACKUP_KEY?: string;
    // Self-hosted identity mapping (design rev2 §4.2). The owner userId is the
    // original ChatGPT user id, preserved so backup owner checks and all ten
    // tables remain valid without remapping.
    BANDROOM_OWNER_USER_ID?: string;
    BANDROOM_OWNER_EMAIL?: string;
    // CF Access JWT validation, pinned per environment (QA/prod distinct AUD).
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_APP_AUD?: string;
    // Service-token identity: common_name carries the Client ID, not the token
    // display name (Cloudflare Application token contract).
    BANDROOM_RUNNER_CLIENT_ID?: string;
    BANDROOM_COACH_CLIENT_ID?: string;
    // Read-only mirror mode for the dual-run comparison window (design §4.6):
    // when "1", all write routes reject service and owner writes alike.
    BANDROOM_READONLY?: string;
    // One-time migration export endpoint gate (design D-11 branch B). Disabled
    // unless explicitly set to "1"; owner-scope only; removed after cutover.
    BANDROOM_MIGRATION_ENABLED?: string;
  }
}
