import os
import pathlib
import pty
import select
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MOCK = '''#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, sys, time
args = sys.argv[1:]
assert args[:5] == ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', '--ephemeral'], args
assert args[args.index('--cd') + 1] == os.getcwd(), args
assert args[args.index('--model') + 1] == 'test-model', args
assert 'model_reasoning_effort="high"' in args, args
assert 'Resume the handoff' in args[-1]
assert 'Revisit a deferred gate only' in args[-1]
assert 'no remaining gate or prerequisite can materially' in args[-1]
assert '- [ ]' in args[-1] and '- [x]' in args[-1]
assert 'Set Status: BLOCKED' in args[-1]
print(json.dumps({'type':'item.completed','item':{'type':'command_execution','aggregated_output':'HIDDEN_PAYLOAD'}}), flush=True)
mode = os.environ['TEST_MODE']
if mode == 'blocked':
 pathlib.Path('nested/roadmap with spaces.md').write_text('Status: BLOCKED\\n')
 sys.exit(0)
if mode == 'interrupt':
 signal.signal(signal.SIGTERM, signal.SIG_IGN)
 child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
 pathlib.Path('pids').write_text(str(os.getpid()) + ' ' + str(child.pid))
 time.sleep(60)
if mode == 'failure':
 print(json.dumps({'type':'turn.failed','error':{'message':'EXPECTED_ERROR'}}))
 print('EXPECTED_STDERR',file=sys.stderr)
 sys.exit(2)
if mode == 'timeout' and not pathlib.Path('marker').exists():
 pathlib.Path('marker').touch()
 sys.exit(124)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'SUMMARY'}}))
pathlib.Path('nested/roadmap with spaces.md').write_text('Status: COMPLETE\\n')
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        (self.base / 'nested').mkdir()
        (self.base / 'nested/roadmap with spaces.md').write_text('Status: IN_PROGRESS\n')
        mock = self.base / 'codex'
        mock.write_text(MOCK)
        mock.chmod(0o755)
        self.env = dict(os.environ, ROADMAP_CODEX=str(mock), ROADMAP_MODEL='test-model',
                        ROADMAP_EFFORT='high', TMPDIR=str(self.base))
        self.command = ['bash', str(ROOT / 'roadmap-runner.sh'), 'nested/roadmap with spaces.md']

    def test_outcomes(self):
        for mode in ('success', 'failure', 'timeout', 'blocked'):
            with self.subTest(mode=mode):
                (self.base / 'nested/roadmap with spaces.md').write_text('Status: IN_PROGRESS\n')
                result = subprocess.run(self.command, cwd=self.base,
                                        env=dict(self.env, TEST_MODE=mode), capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2 if mode == 'failure' else 3 if mode == 'blocked' else 0, result.stderr)
                self.assertNotIn('HIDDEN_PAYLOAD', result.stdout + result.stderr)
                if mode == 'failure':
                    self.assertIn('EXPECTED_ERROR', result.stderr)
                    self.assertIn('EXPECTED_STDERR', result.stderr)
                    self.assertNotIn('iteration 2', result.stdout)
                elif mode == 'blocked':
                    self.assertIn('Roadmap blocked', result.stderr)
                    self.assertNotIn('iteration 2', result.stdout)
                else:
                    self.assertIn('SUMMARY', result.stdout)
                if mode == 'timeout':
                    self.assertIn('iteration 2', result.stdout)
                self.assertEqual(list(self.base.glob('roadmap-runner.*')), [])

    def test_already_blocked(self):
        (self.base / 'nested/roadmap with spaces.md').write_text('Status: BLOCKED\n')
        result = subprocess.run(self.command, cwd=self.base, env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 3)
        self.assertNotIn('===== iteration', result.stdout)

    def test_terminal_ctrl_c(self):
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(self.base)
            os.execvpe('bash', self.command, dict(self.env, TEST_MODE='interrupt'))
        output = b''
        deadline = time.monotonic() + 10
        try:
            while not (self.base / 'pids').exists():
                self.assertLess(time.monotonic(), deadline)
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            time.sleep(0.2)
            os.write(master, b'\x03')
            while True:
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended:
                    break
                self.assertLess(time.monotonic(), deadline)
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        pass
            self.assertEqual(os.waitstatus_to_exitcode(status), 130)
            self.assertNotIn(b'iteration 2', output)
            for target in (self.base / 'pids').read_text().split():
                state = subprocess.run(['ps', '-p', target, '-o', 'stat='], capture_output=True, text=True).stdout.strip()
                self.assertTrue(not state or state.startswith('Z'), state)
            self.assertEqual(list(self.base.glob('roadmap-runner.*')), [])
        finally:
            os.close(master)
            targets = [pid]
            if (self.base / 'pids').exists():
                targets += list(map(int, (self.base / 'pids').read_text().split()))
            for target in targets:
                try:
                    os.kill(target, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    unittest.main()
