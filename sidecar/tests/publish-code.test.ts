import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pupitreMcpPath } from '../src/pupitre';

test('publish_code transmet les plages à la bonne conversation et rapporte les erreurs', async () => {
  let received: unknown;
  let url = '';
  let rejected = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    url = new URL(request.url).pathname;
    received = await request.json();
    return rejected ? Response.json({ error: 'Ligne hors fichier' }, { status: 400 })
      : Response.json({ excerptId: 'excerpt', path: 'src/app.ts', startLine: 20, endLine: 24 }, { status: 201 });
  } });
  const client = new Client({ name: 'publish-code-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [pupitreMcpPath()], env: {
      PATH: process.env.PATH ?? '', PUPITRE_PORT: String(server.port), PUPITRE_CONVERSATION_ID: 'current',
    } }));
    const args = { path: 'src/app.ts', title: 'Initialisation', explanation: 'Configure le service.', start_line: 20, end_line: 24,
      highlights: [{ start_line: 22, end_line: 23 }] };
    const result = await client.callTool({ name: 'publish_code', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(url).toBe('/api/conversations/current/code-excerpts');
    expect(received).toEqual({ path: args.path, title: args.title, explanation: args.explanation,
      startLine: 20, endLine: 24, highlights: [{ startLine: 22, endLine: 23 }] });
    rejected = true;
    const failed = await client.callTool({ name: 'publish_code', arguments: args });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('Ligne hors fichier');
  } finally { await client.close(); server.stop(true); }
});
