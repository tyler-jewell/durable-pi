// A fake TypeScript language server for gate-test.sh. Like the real one, it publishes an empty list when a document opens
// (the syntactic pass) and the real list after a delay (the semantic pass). A gate that takes the first list reads the
// document as clean; the gate must wait for the settled list and refuse. Speaks just enough LSP for the gate.
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
let buf = Buffer.alloc(0);
const SEMANTIC_DELAY_MS = 1_500;
const REAL = [{ range: { start: { line: 0, character: 16 }, end: { line: 0, character: 17 } }, severity: 1, source: "fake-ts", code: 7006, message: "Parameter 'x' implicitly has an 'any' type." }];
const publish = (uri) => {
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: REAL } }), SEMANTIC_DELAY_MS);
};
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "slow-semantic-ls", version: "1" } } });
    else if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didSave") publish(msg.params.textDocument.uri);
    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.method === "exit") process.exit(0);
  }
});
