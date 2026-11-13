'use strict';
// Scripted "shell" run inside the pty by term.test.js.
const out = [];
for (let i = 1; i <= 80; i++) out.push('line ' + String(i).padStart(3, '0'));
out.push('\x1b[31mRED\x1b[0m \x1b[38;2;10;20;30mTRUE\x1b[0m \x1b[1;4mBOLDUL\x1b[0m \x1b[48;5;21mBLUEBG\x1b[0m \x1b[7mINV\x1b[0m \x1b[3mITAL\x1b[0m plain');
out.push('END');
process.stdout.write(out.join('\r\n') + '\r\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => process.stdout.write('GOT:' + JSON.stringify(d) + '\r\n'));
process.stdin.resume();
setTimeout(() => process.exit(0), 20000).unref();
