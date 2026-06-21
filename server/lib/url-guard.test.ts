// Anti-SSRF URL guard. Run: npx tsx server/lib/url-guard.test.ts
import { assertSafeOutboundUrl } from "./url-guard";

let pass = 0;
let fail = 0;
function allows(name: string, url: string) {
  try { assertSafeOutboundUrl(url); pass++; console.log(`PASS allow ${name}`); }
  catch (e) { fail++; console.error(`FAIL allow ${name} - ${(e as Error).message}`); }
}
function blocks(name: string, url: string) {
  try { assertSafeOutboundUrl(url); fail++; console.error(`FAIL block ${name} (was allowed)`); }
  catch { pass++; console.log(`PASS block ${name}`); }
}

allows("public https", "https://mobile.fmcsa.dot.gov/qc/services");
allows("public http", "http://example.com/x");
allows("public ipv4", "http://93.184.216.34/");
blocks("cloud metadata 169.254.169.254", "http://169.254.169.254/latest/meta-data/");
blocks("localhost", "http://localhost:8080/");
blocks("127.0.0.1", "http://127.0.0.1/");
blocks("10.x private", "http://10.0.0.5/");
blocks("192.168.x private", "http://192.168.1.1/");
blocks("172.16.x private", "http://172.16.0.1/");
blocks("0.0.0.0", "http://0.0.0.0/");
blocks("ipv6 loopback", "http://[::1]/");
blocks(".internal host", "http://db.internal/");
blocks("file scheme", "file:///etc/passwd");
blocks("ftp scheme", "ftp://example.com/");
blocks("garbage", ":::::");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
