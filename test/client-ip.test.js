import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIP, fromCloudflare } from "../src/core/rate-limit.js";

const req = (ip, cf) => ({ ip, headers: cf ? { "cf-connecting-ip": cf } : {} });

test("Cloudflare's header is believed when the request came from Cloudflare", () => {
  assert.equal(clientIP(req("172.70.1.2", "84.54.70.10")), "84.54.70.10");
  assert.equal(clientIP(req("::ffff:162.158.3.4", "84.54.70.10")), "84.54.70.10");
  assert.equal(clientIP(req("2606:4700:10::1", "2a03:d000::5")), "2a03:d000::5");
});

test("a direct caller cannot pick its own address with the header", () => {
  assert.equal(clientIP(req("84.54.70.10", "1.2.3.4")), "84.54.70.10");
  assert.equal(clientIP(req("::ffff:84.54.70.10", "1.2.3.4")), "84.54.70.10");
});

test("a proxy on this machine or the private network is believed too", () => {
  assert.equal(clientIP(req("172.18.0.7", "203.0.113.7")), "203.0.113.7");
  assert.equal(clientIP(req("127.0.0.1", "203.0.113.7")), "203.0.113.7");
  assert.equal(clientIP(req("::1", "203.0.113.7")), "203.0.113.7");
  assert.equal(clientIP(req("::ffff:127.0.0.1", "203.0.113.7")), "203.0.113.7");
});

test("without the header the socket's address is used", () => {
  assert.equal(clientIP(req("172.70.1.2")), "172.70.1.2");
  assert.equal(clientIP(req("10.0.0.5")), "10.0.0.5");
  assert.equal(clientIP(req("8.8.8.8", "10.0.0.9")), "8.8.8.8");
});

test("only Cloudflare's ranges count", () => {
  assert.equal(fromCloudflare("104.16.0.1"), true);
  assert.equal(fromCloudflare("104.32.0.1"), false);
  assert.equal(fromCloudflare("not an ip"), false);
  assert.equal(fromCloudflare(undefined), false);
});
