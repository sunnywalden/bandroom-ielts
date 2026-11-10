declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ANALYSIS_SIGNING_KEY?: string;
    ANALYSIS_BUNDLE_VERSION?: string;
    BANDROOM_PUBLIC_ORIGIN?: string;
  }
}
