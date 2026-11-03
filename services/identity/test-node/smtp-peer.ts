// vitest globalSetup (runs in Node, outside workerd): a fake SMTP peer for the SMTP transport tests
// (test/email-transports.test.ts). Plain TCP only; it speaks just enough ESMTP (EHLO, AUTH PLAIN /
// LOGIN, MAIL, RCPT, DATA, RSET, QUIT) and records every session. The tests read the transcripts over
// a small HTTP endpoint. Recipients starting with `reject` get 550; the credentials `smtp-user` /
// `smtp-pass` are the only accepted ones.
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';

interface Session {
  lines: string[];
  auth: string | null;
  data: string | null;
}

const USER = 'smtp-user';
const PASS = 'smtp-pass';

export default async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  const sessions: Session[] = [];
  const smtp = createServer((socket: Socket) => {
    const s: Session = { lines: [], auth: null, data: null };
    sessions.push(s);
    let buffer = '';
    let mode: 'command' | 'data' | 'login-user' | 'login-pass' = 'command';
    let loginUser = '';
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake.smtp.test ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          s.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mode = 'command';
          reply('250 2.0.0 queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          mode = 'login-pass';
          reply(`334 ${Buffer.from('Password:').toString('base64')}`);
          continue;
        }
        if (mode === 'login-pass') {
          const pass = Buffer.from(line, 'base64').toString('utf8');
          mode = 'command';
          s.auth = `login:${loginUser}`;
          reply(loginUser === USER && pass === PASS ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
          continue;
        }
        s.lines.push(line.startsWith('AUTH') ? 'AUTH ***' : line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') reply('250-fake.smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
        else if (verb === 'HELO') reply('250 fake.smtp.test');
        else if (verb === 'AUTH' && /^AUTH PLAIN /i.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          s.auth = `plain:${user}`;
          reply(user === USER && pass === PASS ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
        } else if (verb === 'AUTH' && /^AUTH LOGIN/i.test(line)) {
          mode = 'login-user';
          reply(`334 ${Buffer.from('Username:').toString('base64')}`);
        } else if (verb === 'MAIL') reply('250 2.1.0 ok');
        else if (verb === 'RCPT') reply(/<reject/i.test(line) ? `550 5.1.1 ${line.slice(8)} unknown user` : '250 2.1.5 ok');
        else if (verb === 'DATA') {
          mode = 'data';
          reply('354 end with <CRLF>.<CRLF>');
        } else if (verb === 'RSET') reply('250 ok');
        else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('502 5.5.2 unknown command');
      }
    });
    socket.on('error', () => {});
  });
  const http = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(sessions));
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  provide('smtpPeer', {
    port: (smtp.address() as { port: number }).port,
    transcripts: `http://127.0.0.1:${(http.address() as { port: number }).port}/`,
  });
  return async () => {
    await new Promise((r) => smtp.close(r));
    await new Promise((r) => http.close(r));
  };
}
