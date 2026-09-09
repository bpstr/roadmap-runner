"""Only standard library and fake processes. No authenticated CLI or network required."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'skills/roadmap-runner/scripts/runner.py'
SHELL = ROOT / 'roadmap-runner.sh'
spec = importlib.util.spec_from_file_location('runner', SCRIPT)
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)


class ParserTests(unittest.TestCase):
    def test_fences_comments_yaml_and_quotes(self):
        text = b'---\na: b\n- [ ] yaml\n---\n# Plan\n```md\n- [ ] fake\n```\n<!--\n- [ ] comment\n-->\n> - [ ] quote\n    - [ ] code\n- [ ] actual\n'
        _, tasks = rr.parse(text)
        self.assertEqual([t['title'] for t in tasks], ['actual'])

    def test_nested_children_before_parent(self):
        _, tasks = rr.parse(b'# P\n- [ ] parent\n  - [ ] a\n  - [ ] b\n- [ ] later\n')
        self.assertEqual([t['title'] for t in rr.select(tasks, 3)], ['a', 'b'])
        data = rr.updated(b'# P\n- [ ] parent\n  - [ ] a\n  - [ ] b\n- [ ] later\n', [tasks[1]['id'], tasks[2]['id']])
        self.assertEqual(rr.select(rr.parse(data)[1], 1)[0]['title'], 'parent')

    def test_section_boundary_and_duplicate_ids(self):
        _, tasks = rr.parse(b'# P\n## A\n- [ ] repeat\n- [ ] repeat\n## B\n- [ ] repeat\n')
        self.assertEqual(len(set(t['id'] for t in tasks)), 3)
        self.assertEqual(len(rr.select(tasks, 10)), 2)

    def test_stable_ids_and_preserve_bytes(self):
        data = b'\xef\xbb\xbf# P\r\n1. [ ] Task  \r\n+ [X] Old\r\n'
        _, tasks = rr.parse(data)
        changed = rr.updated(data, [tasks[0]['id']])
        self.assertEqual(changed, data.replace(b'1. [ ]', b'1. [x]'))
        self.assertEqual(tasks[0]['id'], rr.parse(changed)[1][0]['id'])

    def test_inconsistent_checked_parent_rejected(self):
        with self.assertRaises(rr.Halt):
            rr.parse(b'- [x] parent\n  - [ ] child\n')

    def test_empty_or_example_only_rejected(self):
        with self.assertRaises(rr.Halt):
            rr.parse(b'# Hello\n```\n- [ ] sample\n```\n')

    def test_ordered_markers_and_mixed_fence(self):
        _, tasks = rr.parse(b'~~~\n```\n- [ ] fake\n~~~\n1) [ ] yes\n* [x] done\n')
        self.assertEqual([t['title'] for t in tasks], ['yes', 'done'])


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='runner test ')
        self.root = Path(self.tmp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.roadmap = self.root / 'plan with spaces.md'
        self.roadmap.write_text('# Plan\n\n## First\n- [ ] A\n- [ ] B\n\n## Second\n- [ ] C\n')
        self.fake = self.root / 'fake codex'
        fixture = (ROOT / 'tests/fake_codex.py').read_text().split('\n', 1)[1]
        self.fake.write_text('#!' + sys.executable + '\n' + fixture)
        self.fake.chmod(0o700)
        self.env = dict(os.environ, ROADMAP_RUNNER_CODEX_BIN=str(self.fake))
        self.env.pop('ROADMAP_RUNNER_WORKER', None)
        self.children = []

    def tearDown(self):
        # Never leave fixture processes behind, including after an assertion failure.
        directory = self.state_dir()
        if directory.exists():
            (directory / 'CANCEL').write_text('stop')
        for process in self.children:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        self.tmp.cleanup()

    def state_dir(self):
        return self.root / '.roadmap-runner' / rr.digest(self.roadmap.name.encode())[:16]

    def state(self):
        return json.loads((self.state_dir() / 'state.json').read_text())

    def argv(self, action='run', *extra):
        return ['bash', str(SHELL), action, self.roadmap.name, '--repo', str(self.root), *extra]

    def run_cli(self, *extra, action='run', mode='ok'):
        return subprocess.run(self.argv(action, *extra), env=dict(self.env, FAKE_MODE=mode), capture_output=True, text=True, timeout=15)

    def spawn(self, *extra, mode='slow'):
        p = subprocess.Popen(self.argv('run', *extra), env=dict(self.env, FAKE_MODE=mode), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(p)
        self.wait_for(lambda: (self.root / 'fixture-started').exists())
        return p

    def wait_for(self, condition, timeout=7):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(0.03)
        self.fail('Condition did not become true')

    def test_sequential_completion_and_usage(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 3)
        self.assertEqual(self.state()['attempts'], 2)
        self.assertEqual(self.state()['tokens'], 240)  # Cached input is not added twice.
        self.assertEqual(self.state()['status'], 'completed')
        self.assertEqual(self.state()['verification'], 'worker_report_only')

    def test_preview_never_launches_or_creates_state(self):
        self.env['ROADMAP_RUNNER_CODEX_BIN'] = '/does/not/exist'
        result = self.run_cli(action='preview')
        self.assertEqual(result.returncode, 0)
        self.assertIn('BATCH_JSON_BEGIN', result.stdout)
        self.assertFalse((self.root / '.roadmap-runner').exists())

    def test_partial_prefix_and_batch_limit(self):
        result = self.run_cli('--max-batches', '1', mode='partial')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 1)
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual(self.run_cli().returncode, 0)

    def test_nested_parent_verification(self):
        self.roadmap.write_text('# P\n- [ ] parent\n  - [ ] child A\n  - [ ] child B\n')
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.state()['attempts'], 2)

    def test_no_progress_has_finite_bound(self):
        result = self.run_cli('--max-stalls', '2', mode='stall')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.state()['attempts'], 2)
        self.assertNotIn('[x]', self.roadmap.read_text())

    def test_auth_error_stops_without_retry(self):
        result = self.run_cli(mode='fail')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.state()['attempts'], 3)

    def test_blocked_stops_and_explicit_launch_retries(self):
        self.assertEqual(self.run_cli(mode='blocked').returncode, 2)
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual(self.run_cli().returncode, 0)

    def test_bad_receipts_are_not_completions(self):
        for mode in ('foreign', 'reordered', 'unchecked-tests', 'invalid-json'):
            with self.subTest(mode=mode):
                result = self.run_cli(mode=mode)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn('[x]', self.roadmap.read_text())
                # Test independent rejection cases without a pending receipt from the prior case.
                import shutil
                shutil.rmtree(self.root / '.roadmap-runner')

    def test_host_verification_success(self):
        result = self.run_cli('--verify', 'test -s implementation.txt')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.state()['verification'], 'host_command')

    def test_host_verification_failure_is_bounded(self):
        result = self.run_cli('--verify', 'exit 1', '--max-stalls', '2')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.state()['attempts'], 2)
        self.assertNotIn('[x]', self.roadmap.read_text())
        self.assertIn('FAILED', self.state()['handoff'])

    def test_token_boundary_stops_next_batch(self):
        result = self.run_cli('--max-tokens', '100')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 2)

    def test_missing_usage_fails_closed_with_limit(self):
        result = self.run_cli('--max-tokens', '1000', mode='no-usage')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.state()['attempts'], 1)
        self.assertEqual(self.state()['usage_missing'], 1)

    def test_large_log_line_is_streamed(self):
        self.assertEqual(self.run_cli(mode='large-events').returncode, 0)
        self.assertEqual(self.state()['tokens'], 240)

    def test_timeout_terminates_worker(self):
        result = self.run_cli('--batch-timeout', '1', mode='slow')
        self.assertEqual(result.returncode, 2)
        self.assertIn('timeout', self.state()['message'])
        self.assertNotIn('[x]', self.roadmap.read_text())

    def test_worktree_lock_rejects_second_roadmap(self):
        p = self.spawn()
        other = self.root / 'other.md'
        other.write_text('- [ ] Other\n')
        result = subprocess.run(['bash', str(SHELL), 'run', other.name, '--repo', str(self.root)], env=self.env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertIn('owns this worktree', result.stderr)
        self.run_cli(action='stop', *['--now'])
        p.wait(timeout=6)

    def test_graceful_stop_finishes_current_batch(self):
        p = self.spawn()
        result = self.run_cli(action='stop')
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(p.poll())  # It does not kill the active batch.
        self.run_cli('--now', action='stop')
        p.wait(timeout=6)
        self.assertEqual(self.state()['status'], 'paused')

    def test_signal_cleans_up_and_resume_keeps_partial_work(self):
        p = self.spawn()
        (self.root / 'preexisting.txt').write_text('keep this')
        p.terminate()
        p.wait(timeout=6)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual((self.root / 'preexisting.txt').read_text(), 'keep this')

    def test_accepted_checkpoint_replays_after_md_replace(self):
        self.assertEqual(self.run_cli('--max-batches', '1').returncode, 2)
        directory = self.state_dir() / 'batch-000001'
        state = self.state()
        state.update(pending={'directory': str(directory), 'assigned': [t['id'] for t in rr.select(rr.parse((directory / 'roadmap.before.md').read_bytes())[1], 3)]}, tokens=0)
        rr.save(self.state_dir() / 'state.json', state)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.state()['tokens'], 240)
        self.assertEqual(self.state()['attempts'], 2)

    def test_accepted_checkpoint_replays_before_md_replace(self):
        self.assertEqual(self.run_cli('--max-batches', '1').returncode, 2)
        directory = self.state_dir() / 'batch-000001'
        self.roadmap.write_bytes((directory / 'roadmap.before.md').read_bytes())
        state = self.state()
        state.update(pending={'directory': str(directory), 'assigned': []}, tokens=0)
        rr.save(self.state_dir() / 'state.json', state)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 3)

    def test_roadmap_edits_never_overwritten(self):
        result = self.run_cli(mode='edit-roadmap')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.roadmap.read_text(), '# Unauthorized change\n')

    def test_corrupt_state_fails_closed(self):
        self.assertEqual(self.run_cli('--max-batches', '1').returncode, 2)
        (self.state_dir() / 'state.json').write_text('corrupt')
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 2)

    def test_recursive_workers_cannot_launch(self):
        self.env['ROADMAP_RUNNER_WORKER'] = '1'
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn('recursively', result.stderr)

    def test_missing_binary_and_invalid_options(self):
        self.env['ROADMAP_RUNNER_CODEX_BIN'] = '/missing'
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual(self.run_cli('--batch-size', '0').returncode, 2)
        self.assertNotIn('[x]', self.roadmap.read_text())

    def test_symlink_roadmap_rejected(self):
        actual = self.root / 'actual.md'
        self.roadmap.rename(actual)
        self.roadmap.symlink_to(actual)
        self.assertEqual(self.run_cli().returncode, 2)

    def test_rejected_result_can_be_retried_explicitly(self):
        self.assertEqual(self.run_cli(mode='invalid-json').returncode, 2)
        self.assertIsNone(self.state()['pending'])
        self.assertEqual(self.run_cli().returncode, 0)

    def test_recover_reservation_before_artifact_creation(self):
        self.assertEqual(self.run_cli('--max-batches', '1').returncode, 2)
        state = self.state()
        state.update(attempts=2, pending={'directory': str(self.state_dir() / 'batch-000002'), 'assigned': [], 'verify': None})
        rr.save(self.state_dir() / 'state.json', state)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.roadmap.read_text().count('[x]'), 3)

    def test_stop_still_works_with_malformed_roadmap(self):
        p = self.spawn()
        self.roadmap.write_text('broken input')
        self.assertEqual(self.run_cli('--now', action='stop').returncode, 0)
        p.wait(timeout=6)

    def test_killed_shell_does_not_release_live_worker_lock(self):
        p = self.spawn()
        p.kill()
        p.wait(timeout=3)
        result = self.run_cli('--max-batches', '1')
        self.assertEqual(result.returncode, 2)
        self.assertIn('owns this worktree', result.stderr)
        self.assertEqual(self.run_cli('--now', action='stop').returncode, 0)
        self.wait_for(lambda: self.state().get('status') == 'paused')
        self.assertEqual(self.run_cli().returncode, 0)

    def test_pending_recovery_keeps_original_verification_gate(self):
        self.assertEqual(self.run_cli('--max-batches', '1').returncode, 2)
        directory = self.state_dir() / 'batch-000001'
        accepted = json.loads((directory / 'accepted.json').read_text())
        (directory / 'accepted.json').unlink()
        self.roadmap.write_bytes((directory / 'roadmap.before.md').read_bytes())
        state = self.state()
        state.update(pending={'directory': str(directory), 'assigned': accepted['completed_ids'], 'verify': 'exit 1'}, tokens=0)
        rr.save(self.state_dir() / 'state.json', state)
        self.assertEqual(self.run_cli('--max-stalls', '1').returncode, 2)
        self.assertNotIn('[x]', self.roadmap.read_text())

    def test_context_file_is_resolved_and_not_bulk_injected(self):
        brief = self.root / 'brief.md'
        brief.write_text('PRIVATE BRIEF CONTENT')
        result = self.run_cli('--context', 'brief.md', action='preview')
        self.assertEqual(result.returncode, 0)
        self.assertIn(str(brief), result.stdout)
        self.assertNotIn('PRIVATE BRIEF CONTENT', result.stdout)
        self.assertEqual(self.run_cli('--context', 'missing.md', action='preview').returncode, 2)

    def test_all_complete_does_not_start_worker(self):
        self.roadmap.write_text('- [x] Existing complete task\n')
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertFalse((self.root / 'fixture-started').exists())
        self.assertEqual(self.state()['attempts'], 0)

    def test_background_start_finishes_without_parent_agent(self):
        result = self.run_cli(action='start')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: self.state().get('status') == 'completed')
        self.assertEqual(self.roadmap.read_text().count('[x]'), 3)


class PackageTests(unittest.TestCase):
    def test_versions_and_runtime_paths(self):
        for relative in ('plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'):
            data = json.loads((ROOT / relative).read_text())
            self.assertEqual(data['name'], 'roadmap-runner')
            self.assertEqual(data['version'], rr.VERSION)
        self.assertTrue((SCRIPT.parent / 'roadmap-runner.sh').exists())
        self.assertTrue((SCRIPT.parent / 'worker-prompt.md').exists())
        self.assertEqual(json.loads((ROOT / '.agents/plugins/marketplace.json').read_text())['plugins'][0]['source']['path'], './')
        schema = json.loads((SCRIPT.parent / 'result.schema.json').read_text())
        self.assertFalse(schema['additionalProperties'])

    def test_shell_syntax(self):
        for path in (SHELL, SCRIPT.parent / 'roadmap-runner.sh'):
            subprocess.run(['bash', '-n', str(path)], check=True)


if __name__ == '__main__':
    unittest.main()
