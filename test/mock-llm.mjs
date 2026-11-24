// Minimal OpenAI-compatible model for end-to-end tests.
// A user message "WRITEFILE <name>" makes the model call Mukai's file_operations
// tool (which needs approval in ask-for-approval mode); otherwise it replies with text.
import http from 'node:http';
const port = Number(process.env.MOCK_LLM_PORT || 11434);
http
  .createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
    }
    const json = body ? JSON.parse(body) : {};
    const msgs = json.messages || [];
    const asks = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === 'user' && /WRITEFILE \S+/.test(JSON.stringify(m.content)));
    const ask = asks.pop();
    const toolResult = ask && msgs.slice(ask[1]).find((m) => m.role === 'tool');
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock-1' };
    const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (ask && !toolResult) {
      const name = /WRITEFILE (\S+)/.exec(JSON.stringify(ask[0].content))[1].replace(/[^\w.-]/g, '');
      const args = JSON.stringify({ action: 'write_file', path: name, content: 'written via MCP approval test' });
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: 'file_operations', arguments: args } }] });
      send({}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
    const reply = toolResult ? `Tool finished: ${JSON.stringify(toolResult.content).slice(0, 120)}` : 'Hello from the mock model via MCP!';
    send({ role: 'assistant', content: reply });
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  })
  .listen(port, '127.0.0.1', () => console.log(`mock LLM on ${port}`));
