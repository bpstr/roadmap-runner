#!/usr/bin/env python3
"""Offline CLI fixture. NEVER forwards requests to a real provider."""
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import time

if '--version' in sys.argv:
    print('codex fixture')
    sys.exit(0)
args = sys.argv[1:]
assert 'exec' in args and '--json' in args and '--ephemeral' in args
assert args[args.index('--model') + 1] == os.environ.get('EXPECTED_MODEL', 'gpt-5.6-sol')
assert args[args.index('--sandbox') + 1] == 'workspace-write'
assert '--dangerously-bypass-approvals-and-sandbox' not in args
assert args[args.index('--ask-for-approval') + 1] == 'never'
prompt = sys.stdin.read()
job = json.loads(prompt.split('BATCH_JSON_BEGIN\n', 1)[1].split('\nBATCH_JSON_END', 1)[0])
output = Path(args[args.index('--output-last-message') + 1])
root = Path(args[args.index('--cd') + 1])
mode = os.environ.get('FAKE_MODE', 'ok')
(root / 'fixture-started').write_text(str(os.getpid()))
if os.environ.get('FAKE_ARGS'):
    Path(os.environ['FAKE_ARGS']).write_text(json.dumps(args))
if mode == 'slow':
    time.sleep(20)
if mode == 'ignore-term':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(20)
if mode == 'fail':
    print('Authentication or model unavailable fixture', file=sys.stderr)
    sys.exit(7)
if mode == 'edit-roadmap':
    Path(job['roadmap']).write_text('# Unauthorized change\n')
if mode == 'invalid-json':
    output.write_text('not json')
    sys.exit(0)
ids = [t['id'] for t in job['tasks']]
if mode == 'foreign':
    ids = ['not-assigned']
if mode == 'reordered':
    ids = list(reversed(ids))
if mode in ('stall', 'blocked'):
    ids = []
if mode == 'partial':
    ids = ids[:1]
checks = [{'command': 'fixture local check', 'outcome': 'passed', 'detail': 'Offline fixture passed'}]
if mode == 'unchecked-tests':
    checks[0]['outcome'] = 'not_run'
result = {'status': 'blocked' if mode == 'blocked' else 'progress', 'completed_ids': ids,
          'summary': 'Offline batch result', 'handoff': 'Fixture handoff', 'checks': checks}
(root / 'implementation.txt').open('a').write(','.join(ids) + '\n')
output.write_text(json.dumps(result))
if mode == 'large-events':
    print('x' * (2 * 1024 * 1024))
if mode != 'no-usage':
    print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 20}}))
