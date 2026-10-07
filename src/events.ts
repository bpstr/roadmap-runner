import fs from 'node:fs';
export const attentionTypes = new Set(['runner.blocked', 'runner.needs_attention', 'runner.failed', 'runner.capacity_exhausted', 'runner.usage_wait_expired']);
export const eventTypes = ['runner.started', 'runner.stopped', 'runner.turn_starting', 'runner.turn_finished', 'runner.blocked', 'runner.needs_attention', 'runner.unblocked', 'runner.usage_paused', 'runner.usage_resumed', 'runner.usage_wait_expired', 'runner.turn_limit_reached', 'runner.capacity_wait', 'runner.capacity_exhausted', 'runner.failed', 'runner.completed', 'runner.recovery_wait', 'runner.supervisor_deferred'];
export const appendEvent = (file: string, event: any) => {
  const line = JSON.stringify(event) + '\n';
  if (Buffer.byteLength(line) > 8192) throw new Error('Event exceeds journal record budget');
  fs.appendFileSync(file, line, { mode: 0o600 });
  if (fs.statSync(file).size > 1024 * 1024) {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const tail = Buffer.alloc(512 * 1024);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length); fs.closeSync(fd);
    fs.writeFileSync(file, tail.subarray(tail.indexOf(10) + 1), { mode: 0o600 });
  }
};
export const readEvents = (file: string, cursor = 0, limit = 50) => {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid event cursor');
  if (!fs.existsSync(file)) return { events: [], cursor, cursorExpired: false, eventsTruncated: false, malformedRecords: 0 };
  const records = fs.readFileSync(file, 'utf8').split('\n'); records.pop();
  const events: any[] = []; let malformedRecords = 0;
  for (const line of records) { try { const event = JSON.parse(line); if (!Number.isSafeInteger(event.sequence)) continue; events.push(event); } catch { malformedRecords++; } }
  const oldest = events[0]?.sequence || 1; const expired = cursor > 0 && cursor < oldest - 1;
  const pending = events.filter(event => event.sequence > cursor); const selected: any[] = []; let budget = 0;
  for (const event of pending.slice(0, Math.min(limit, 50))) { const size = Buffer.byteLength(JSON.stringify(event)); if (budget + size > 12000) break; selected.push(event); budget += size; }
  return { events: selected, cursor: selected.at(-1)?.sequence ?? cursor, cursorExpired: expired, oldestCursor: oldest - 1, eventsTruncated: selected.length < pending.length, malformedRecords };
};
