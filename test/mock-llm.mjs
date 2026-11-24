// Minimal OpenAI-compatible model for end-to-end tests.
// Trigger phrases in the latest user message:
//   WRITEFILE <name>  -> calls file_operations (a tool approval in ask-for-approval mode)
//   ASKQ              -> asks the user a question with suggested answers (communicate/clarification)
//   ASKOK             -> asks the user for a yes/no go-ahead (communicate/approval)
//   DELEGATE <botId> <task>  -> hands <task> to a sub-bot (manage_bot send_message, mode wait)
// Otherwise (or once the tool result is in) it replies with plain text.
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
    const asks = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === 'user' && /WRITEFILE \S+|ASKQ|ASKOK|DELEGATE/.test(JSON.stringify(m.content)));
    const ask = asks.pop();
    const toolResult = ask && msgs.slice(ask[1]).find((m) => m.role === 'tool');
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock-1' };
    const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (ask && !toolResult) {
      const said = JSON.stringify(ask[0].content);
      let tool = 'communicate';
      let args;
      const delegate = /DELEGATE (\S+) (.+?)(\\n|"|$)/.exec(said);
      if (delegate) {
        tool = 'manage_bot';
        args = { action: 'send_message', botId: delegate[1], message: delegate[2], mode: 'wait' };
      } else if (/ASKQ/.test(said))
        args = { action: 'clarification', question: 'Which colour should the report use?', options: [
          { label: 'Blue', description: 'Calm and corporate', recommended: true },
          { label: 'Green', description: 'Fresh', recommended: false },
        ] };
      else if (/ASKOK/.test(said)) args = { action: 'approval', question: 'May I publish the draft?' };
      else {
        tool = 'file_operations';
        args = { action: 'write_file', path: /WRITEFILE (\S+)/.exec(said)[1].replace(/[^\w.-]/g, ''), content: 'written via MCP approval test' };
      }
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
      send({}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
    const reply = toolResult ? `Tool finished: ${JSON.stringify(toolResult.content).slice(0, 120)}` : 'Hello from the mock model via MCP!';
    send({ role: 'assistant', content: reply });
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  })
  .listen(port, '127.0.0.1', () => console.log(`mock LLM on ${port}`));
