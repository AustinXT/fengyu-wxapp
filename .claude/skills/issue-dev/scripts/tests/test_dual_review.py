import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

    def test_dsh_requires_a_complete_json_report(self):
        self.assertEqual(r.parse_report(json.dumps(GOOD, indent=2), 'deepseek'), GOOD)
        for raw in ['', '```json\n' + json.dumps(GOOD) + '\n```',
                    json.dumps({'subtype': 'success', 'structured_output': GOOD}),
                    json.dumps(GOOD) + '\n' + json.dumps({'error': 'failed'})]:
            with self.assertRaises(ValueError):
                r.parse_report(raw, 'deepseek')

    def test_finding_requires_evidence(self):
        with self.assertRaises(ValueError):
            r.validate_report(dict(GOOD, findings=[{'severity': 'P2', 'scope': 'introduced'}]))
        with self.assertRaises(ValueError):
            r.validate_report(dict(GOOD, status='passed'))

    def test_commands_disable_tools_and_do_not_change_parent_env(self):
        args = SimpleNamespace(glm_model='zhipuai-coding-plan/glm-5.3[1m]', deepseek_model='deepseek-flash[1m]')
        with tempfile.TemporaryDirectory() as directory, patch.dict(r.os.environ, {
                'DEEPSEEK_API_KEY': 'test', 'ANTHROPIC_BASE_URL': 'wrong', 'ANTHROPIC_AUTH_TOKEN': 'unrelated',
                'CLAUDECODE': 'nested', 'DSH_HOME': '/original-dsh', 'DSH_TOOLS_MODE': 'code',
                'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX': '8192'}):
            args.out = Path(directory)
            cmd, env = r.command('deepseek', args)
            self.assertEqual(cmd, ['dsh', '--profile', 'headless', 'review'])
            self.assertNotIn('ANTHROPIC_BASE_URL', env)
            self.assertNotIn('ANTHROPIC_AUTH_TOKEN', env)
            self.assertNotIn('CLAUDECODE', env)
            self.assertNotIn('DSH_TOOLS_MODE', env)
            self.assertEqual(env['DEEPSEEK_API_KEY'], 'test')
            self.assertEqual(env['DSH_TELEMETRY_DISABLED'], '1')
            profile = Path(env['DSH_HOME']) / 'profiles/headless'
            manifest = json.loads((profile / 'package.json').read_text())
            self.assertEqual(manifest['dsh']['profile']['bundles'], [])
            rows = json.loads((profile / 'cordis.patch.yml').read_text().splitlines()[0].removeprefix('- insert: '))
            configs = {row['id']: row.get('config') for row in rows}
            self.assertEqual(configs['agent-default-model'], {'provider': 'deepseek-official', 'model': 'deepseek-flash'})
            self.assertEqual(configs['llm-deepseek']['baseURL'], 'https://api.deepseek.com')
            self.assertEqual(configs['llm-deepseek']['maxTokens'], 131072)
            self.assertEqual(configs['credentials']['path'], '/original-dsh/.credentials.yaml')
            self.assertFalse(any(row['id'].startswith('tool-') for row in rows))
            self.assertNotIn('agent-instructions', configs)
            self.assertNotIn('settings', configs)
            self.assertEqual(r.os.environ['ANTHROPIC_BASE_URL'], 'wrong')
            self.assertEqual(r.os.environ['DSH_HOME'], '/original-dsh')
            cmd, env = r.command('glm', args)
            self.assertEqual(json.loads(env['OPENCODE_PERMISSION']), {'*': 'deny'})
            self.assertEqual(json.loads(env['OPENCODE_CONFIG_CONTENT'])['plugin'], [])
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
            code = 'import sys,json,os,stat; assert stat.S_ISREG(os.fstat(0).st_mode); data=sys.stdin.read(); print(json.dumps({"type":"text","part":{"text":json.dumps({"status":"complete","summary":data,"findings":[]})}}))'
            with patch.object(r, 'command', return_value=([r.sys.executable, '-c', code], r.os.environ.copy())):
                result = r.run_one('glm', args, 'packet with `backticks` and $(literal)')
            self.assertEqual(result['report']['summary'], 'packet with `backticks` and $(literal)')
            args.timeout = 0.1
            with patch.object(r, 'command', return_value=([r.sys.executable, '-c', 'import time; time.sleep(5)'], r.os.environ.copy())):
                result = r.run_one('glm', args, 'packet')
            self.assertEqual(result['status'], 'failed')
            self.assertIn('超时', result['error'])

    def test_dsh_nonzero_exit_cannot_pass_even_with_valid_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'dsh-workspace').mkdir()
            args = SimpleNamespace(out=root, cwd=root, timeout=2, deepseek_model='deepseek-flash')
            code = 'import sys; print(' + repr(json.dumps(GOOD)) + '); sys.exit(1)'
            with patch.object(r, 'command', return_value=([r.sys.executable, '-c', code], r.os.environ.copy())):
                result = r.run_one('deepseek', args, 'packet')
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['harness'], 'dsh')

    @unittest.skipUnless(shutil.which('dsh'), 'dsh 未安装')
    def test_real_dsh_native_request_has_no_tools_and_preserves_packet(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for delta, finish in [({'role': 'assistant', 'content': json.dumps(GOOD)}, None), ({}, 'stop')]:
                    event = {'id': 'test', 'object': 'chat.completion.chunk',
                             'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_prepare = r.prepare_dsh
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(r.os.environ, {
                    'DEEPSEEK_API_KEY': 'test', 'DSH_HOME': str(Path(directory) / 'original-home')}):
                args = SimpleNamespace(out=Path(directory), cwd=Path(directory), timeout=20, deepseek_model='deepseek-flash')
                def local_prepare(args, env):
                    cmd = original_prepare(args, env)
                    config = Path(env['DSH_HOME']) / 'profiles/headless/cordis.patch.yml'
                    config.write_text(config.read_text().replace('https://api.deepseek.com', f'http://127.0.0.1:{server.server_port}'))
                    return cmd
                packet = '审查材料 `literal` $(literal)\n中文与换行\n' + '大输入完整保留\n' * 150000 + json.dumps(GOOD)
                with patch.object(r, 'prepare_dsh', side_effect=local_prepare):
                    result = r.run_one('deepseek', args, packet)
                self.assertEqual(result['status'], 'complete', result)
                self.assertEqual(result['report'], GOOD)
                self.assertEqual(len(requests), 1)
                request = requests[0]
                self.assertEqual(request['model'], 'deepseek-flash')
                self.assertFalse(request.get('tools'))
                self.assertEqual(request['max_tokens'], 131072)
                self.assertEqual((args.out / 'deepseek.stdin.txt').stat().st_mode & 0o777, 0o600)
                self.assertEqual(request['messages'][-1]['content'], packet)
                self.assertNotIn('ANTHROPIC_', (args.out / 'deepseek.stdout.jsonl').read_text())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

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
