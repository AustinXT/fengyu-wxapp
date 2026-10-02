import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('dual_review', Path(__file__).parents[1] / 'dual_review.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
GOOD = {'status': 'complete', 'summary': '已审', 'findings': []}


class ReviewTests(unittest.TestCase):
    def test_opencode_text_and_silent_error(self):
        raw = json.dumps({'type': 'text', 'part': {'text': json.dumps(GOOD)}})
        self.assertEqual(r.parse_report(raw, 'glm'), GOOD)
        with self.assertRaises(ValueError):
            r.parse_report(raw + '\n' + json.dumps({'type': 'error', 'error': {'message': 'Insufficient Balance'}}), 'glm')
        with self.assertRaises(ValueError):
            r.parse_report(json.dumps({'type': 'step_start'}), 'glm')

    def test_claude_success_is_required(self):
        self.assertEqual(r.parse_report(json.dumps({'subtype': 'success', 'structured_output': GOOD}), 'deepseek'), GOOD)
        for wrapper in [{'subtype': 'error', 'result': json.dumps(GOOD)}, {'subtype': 'success', 'is_error': True, 'structured_output': GOOD}]:
            with self.assertRaises(ValueError):
                r.parse_report(json.dumps(wrapper), 'deepseek')

    def test_finding_requires_evidence(self):
        with self.assertRaises(ValueError):
            r.validate_report(dict(GOOD, findings=[{'severity': 'P2', 'scope': 'introduced'}]))
        with self.assertRaises(ValueError):
            r.validate_report(dict(GOOD, status='passed'))

    def test_deepseek_cannot_use_anthropic_credentials(self):
        with patch.object(r.Path, 'home', return_value=Path('/nonexistent')):
            with self.assertRaises(ValueError):
                r.deepseek_token({'ANTHROPIC_BASE_URL': 'https://api.anthropic.com', 'ANTHROPIC_AUTH_TOKEN': 'other'})
            self.assertEqual(r.deepseek_token({'DEEPSEEK_API_KEY': 'deepseek-test'}), 'deepseek-test')

    def test_commands_disable_tools_and_do_not_change_parent_env(self):
        args = SimpleNamespace(glm_model='zhipuai-coding-plan/glm-5.3[1m]', deepseek_model='deepseek-flash[1m]')
        with patch.dict(r.os.environ, {'DEEPSEEK_API_KEY': 'test', 'ANTHROPIC_BASE_URL': 'wrong', 'CLAUDECODE': 'nested', 'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX': '8192'}):
            cmd, env = r.command('deepseek', args)
            self.assertIn('--bare', cmd)
            self.assertEqual(cmd[cmd.index('--model') + 1], 'deepseek-flash[1m]')
            self.assertEqual(cmd[cmd.index('--tools') + 1], '')
            self.assertEqual(env['ANTHROPIC_BASE_URL'], 'https://api.deepseek.com/anthropic')
            self.assertNotIn('CLAUDECODE', env)
            self.assertEqual(r.os.environ['ANTHROPIC_BASE_URL'], 'wrong')
            cmd, env = r.command('glm', args)
            self.assertEqual(json.loads(env['OPENCODE_PERMISSION']), {'*': 'deny'})
            self.assertIn('--pure', cmd)
            self.assertEqual(cmd[cmd.index('--model') + 1], 'zhipuai-coding-plan/glm-5.3')
            limits = json.loads(env['OPENCODE_CONFIG_CONTENT'])['provider']['zhipuai-coding-plan']['models']['glm-5.3']['limit']
            self.assertEqual(limits, {'context': 1000000, 'output': 131072})
            self.assertEqual(env['OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX'], '131072')
            self.assertEqual(r.os.environ['OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX'], '8192')

    def test_explicit_other_glm_model_is_not_rewritten_as_1m(self):
        args = SimpleNamespace(glm_model='zhipuai-coding-plan/glm-4.6v')
        with patch.dict(r.os.environ, {}, clear=True):
            cmd, env = r.command('glm', args)
        self.assertEqual(cmd[cmd.index('--model') + 1], args.glm_model)
        self.assertNotIn('provider', json.loads(env['OPENCODE_CONFIG_CONTENT']))
        self.assertNotIn('OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX', env)

    def test_real_subprocess_consumes_stdin_and_timeout_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(out=Path(directory), cwd=Path(directory), timeout=2, glm_model='test')
            code = 'import sys,json; data=sys.stdin.read(); print(json.dumps({"type":"text","part":{"text":json.dumps({"status":"complete","summary":data,"findings":[]})}}))'
            with patch.object(r, 'command', return_value=([r.sys.executable, '-c', code], r.os.environ.copy())):
                result = r.run_one('glm', args, 'packet with `backticks` and $(literal)')
            self.assertEqual(result['report']['summary'], 'packet with `backticks` and $(literal)')
            args.timeout = 0.1
            with patch.object(r, 'command', return_value=([r.sys.executable, '-c', 'import time; time.sleep(5)'], r.os.environ.copy())):
                result = r.run_one('glm', args, 'packet')
            self.assertEqual(result['status'], 'failed')
            self.assertIn('超时', result['error'])

    def test_snapshot_gate_and_exit_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
            git('init')
            git('config', 'user.email', 'test@example.com')
            git('config', 'user.name', 'Test')
            (root / 'code.txt').write_text('before')
            git('add', 'code.txt')
            git('commit', '-m', 'base')
            git('update-ref', 'refs/remotes/origin/dev', 'HEAD')
            (root / 'code.txt').write_text('after')
            git('commit', '-am', 'change')
            context = root.parent / (root.name + '-context.md')
            context.write_text('验收与关键文件')
            self.addCleanup(context.unlink)
            finding = {'severity': 'P2', 'scope': 'introduced', 'location': 'code.txt:1',
                       'trigger': 'case', 'impact': 'failure', 'evidence': 'diff'}
            for index, (status, findings, expected) in enumerate([
                    ('complete', [], 0), ('complete', [finding], 2), ('incomplete', [], 3)]):
                out = root.parent / (root.name + '-out-' + str(index))
                self.addCleanup(__import__('shutil').rmtree, out)
                argv = ['dual_review', '--cwd', str(root), '--context', str(context), '--out', str(out)]
                result = {'status': status, 'report': dict(GOOD, status=status, findings=findings)}
                with patch.object(r.sys, 'argv', argv), patch.object(r, 'run_one', side_effect=lambda name, *a: dict(result, lineage=name)):
                    self.assertEqual(r.main(), expected)
                summary = json.loads((out / 'summary.json').read_text())
                self.assertTrue(summary['workspace_unchanged'])
                self.assertEqual(summary['exit_code'], expected)
            (root / 'code.txt').write_text('uncommitted')
            with patch.object(r.sys, 'argv', argv), self.assertRaises(SystemExit):
                r.main()


if __name__ == '__main__':
    unittest.main()
