// CSRF origin policy (rev2 S17). Same-origin browser requests and non-browser
// clients (no Origin / no Sec-Fetch-Site) are allowed; cross-origin or a
// cross-site Sec-Fetch-Site is refused.
import test from "node:test";
import assert from "node:assert/strict";

const {crossOrigin} = await import("../app/api/shared.ts");
const url = "https://bandroom.example/api/state";
const req = headers => new Request(url, {method: "POST", headers});

test("same-origin and non-browser requests are allowed", () => {
  assert.equal(crossOrigin(req({Origin: "https://bandroom.example"})), false);
  assert.equal(crossOrigin(req({})), false);
  assert.equal(crossOrigin(req({"Sec-Fetch-Site": "same-origin"})), false);
});

test("cross-origin and cross-site requests are refused", () => {
  assert.equal(crossOrigin(req({Origin: "https://evil.example"})), true);
  assert.equal(crossOrigin(req({"Sec-Fetch-Site": "cross-site"})), true);
  // absent Origin but cross-site fetch is still refused
  assert.equal(crossOrigin(req({"Sec-Fetch-Site": "cross-site", Origin: ""})), true);
});