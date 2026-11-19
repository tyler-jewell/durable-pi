// A fake Bash language server for gate-test.sh. Like a real publishing server, it can answer about the wrong text first:
// the moment a document opens it publishes an empty list for an OLDER version, and only after a delay the real list for
// the version that was sent. A gate that takes the first publish reads the file as clean; the gate must wait for the
// publish that carries the version it sent. Speaks just enough LSP for the gate.
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
let buf = Buffer.alloc(0);
const REAL_DELAY_MS = 1_200;
const REAL = [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } }, severity: 1, source: "fake-bash", code: "SC0000", message: "planted finding" }];
const publish = ({ uri, version }) => {
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version: version - 1, diagnostics: [] } });
  setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: REAL } }), REAL_DELAY_MS);
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
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "stale-publish-ls", version: "1" } } });
    else if (msg.method === "textDocument/didOpen") publish(msg.params.textDocument);
    else if (msg.method === "textDocument/didChange") publish(msg.params.textDocument);
    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.method === "exit") process.exit(0);
  }
});
