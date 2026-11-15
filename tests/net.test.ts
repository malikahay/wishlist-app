import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, assertPublicUrl, safeFetch, UnsafeUrlError } from "../lib/net.ts";

test("private and special addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1",
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
});

test("url checks", () => {
  assert.throws(() => assertPublicUrl("http://localhost/x"), UnsafeUrlError);
  assert.throws(() => assertPublicUrl("http://[::1]/"), UnsafeUrlError);
  assert.throws(() => assertPublicUrl("http://169.254.169.254/latest"), UnsafeUrlError);
  assert.throws(() => assertPublicUrl("file:///etc/passwd"), UnsafeUrlError);
  assert.throws(() => assertPublicUrl("http://user:pw@example.com/"), UnsafeUrlError);
  assert.throws(() => assertPublicUrl("http://example.com:8080/"), UnsafeUrlError);
  assert.doesNotThrow(() => assertPublicUrl("https://example.com/p?id=1"));
});

test("hostnames resolving to private IPs are refused at connect time", async () => {
  // localtest.me and its subdomains resolve to 127.0.0.1 in public DNS
  await assert.rejects(safeFetch("http://app.localtest.me/", { timeoutMs: 5000 }), (e: any) => {
    let c = e;
    while (c) {
      if (c instanceof UnsafeUrlError) return true;
      c = c.cause;
    }
    return false;
  });
});
