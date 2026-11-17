import json
import os
import re
import time
from datetime import datetime, timezone
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
ENVIRONMENTS = ("local", "development", "staging", "production")

def database():
    return sqlite3.connect(ROOT / 'traces.sqlite3')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def public_record(record):
    if record['kind'] != 'model':
        return record
    visible = dict(record)
    visible['has_api_key'] = bool(visible.pop('api_key', ''))
    return visible

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'web'), **kwargs)

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def records(self):
        with database() as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
            )""")
            return [json.loads(row[0]) for row in connection.execute(
                'SELECT payload FROM records ORDER BY rowid DESC'
            )]

    def save_record(self, kind, data):
        record = dict(data, id=uuid4().hex, kind=kind, at=datetime.now(timezone.utc).isoformat())
        with database() as connection:
            connection.execute('INSERT INTO records VALUES (?, ?, ?)',
                               (record['id'], kind, json.dumps(record, allow_nan=False)))
        return record

    def platform_action(self, action, data):
        records = self.records()
        def required_text(key):
            value = data.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(key + ' is required')
            return value.strip()

        def record_for(key, kind):
            identifier = required_text(key)
            record = next((item for item in records if item['id'] == identifier and item['kind'] == kind), None)
            if record is None:
                raise ValueError(kind + ' was not found')
            return record

        if action == 'models':
            name = required_text('name')
            model = required_text('model')
            url = required_text('url')
            endpoint = urlsplit(url)
            loopback = endpoint.hostname in ('localhost', '127.0.0.1', '::1')
            if not endpoint.hostname or endpoint.username is not None or endpoint.fragment or (
                endpoint.scheme != 'https' and not (loopback and endpoint.scheme == 'http')
            ):
                raise ValueError('Use HTTPS or a local HTTP model endpoint without embedded credentials')
            key = data.get('api_key')
            return public_record(self.save_record('model', dict(
                name=name, model=model, url=url, api_key=key.strip() if isinstance(key, str) else ''
            )))
        if action == 'datasets':
            return self.save_record('dataset', {'name': required_text('name')})
        if action == 'examples':
            dataset = record_for('dataset', 'dataset')
            if 'input' not in data or 'expected' not in data:
                raise ValueError('input and expected are required')
            return self.save_record('example', {'dataset': dataset['id'], 'input': data['input'],
                                                'expected': data['expected']})
        if action == 'prompts':
            return self.save_record('prompt', {'name': required_text('name'),
                                               'template': required_text('template')})
        if action == 'deployments':
            prompt = record_for('prompt', 'prompt')
            return self.save_record('deployment', {'name': required_text('name'), 'prompt': prompt['id']})
        if action == 'agents':
            name = required_text('name')
            source = data.get('source', 'studio')
            if source not in ('studio', 'external'):
                raise ValueError('Invalid agent source')
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:40].rstrip('-') or 'agent'
            agent = dict(name=name, source=source, identifier=slug + '-' + uuid4().hex[:12])
            if source == 'studio':
                agent['instructions'] = required_text('instructions')
                if data.get('provider'):
                    agent['provider'] = record_for('provider', 'model')['id']
                elif not os.environ.get('TRACE_STUDIO_MODEL'):
                    raise ValueError('Choose a model before creating the agent')
            return self.save_record('agent', agent)

        def render(template, value):
            variables = value if isinstance(value, dict) else {'input': value}
            def substitute(match):
                key = match[1]
                if key not in variables:
                    raise ValueError('Missing prompt variable: ' + key)
                value = variables[key]
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            return re.sub(r'\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}', substitute, template)

        def execute(prompt, value, instructions=None, provider=None):
            if instructions is not None:
                if not isinstance(value, str) or not value.strip():
                    raise ValueError('Enter a message to run this agent')
                rendered = value
            else:
                rendered = render(prompt['template'], value)
            model = provider['model'] if provider else os.environ.get('TRACE_STUDIO_MODEL')
            if not model:
                if instructions is not None:
                    raise ValueError('Configure a model service before running a Studio agent')
                return rendered, 0
            endpoint = provider['url'] if provider else os.environ.get('TRACE_STUDIO_MODEL_URL')
            if not endpoint:
                raise ValueError('Set TRACE_STUDIO_MODEL_URL to the chat completions endpoint')
            headers = {'Content-Type': 'application/json'}
            api_key = provider['api_key'] if provider else os.environ.get('TRACE_STUDIO_MODEL_KEY')
            if api_key:
                headers['Authorization'] = 'Bearer ' + api_key
            messages = [dict(role='user', content=rendered)]
            if instructions is not None:
                messages.insert(0, dict(role='system', content=instructions))
            payload = dict(model=model, messages=messages)
            try:
                with build_opener(NoRedirect()).open(Request(endpoint, json.dumps(payload).encode(), headers), timeout=30) as response:
                    result = json.load(response)
                content = result['choices'][0]['message']['content']
                if not isinstance(content, str):
                    raise ValueError('Expected a text response')
                return content, result.get('usage', {}).get('total_tokens', 0)
            except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError) as error:
                raise ValueError('Model inference failed (' + type(error).__name__ + ')') from error

        if action == 'model-test':
            provider = record_for('provider', 'model')
            output, tokens = execute(None, required_text('message'), 'Reply briefly.', provider)
            return dict(output=output, tokens=tokens)
        if action == 'experiments':
            dataset = record_for('dataset', 'dataset')
            prompt = record_for('prompt', 'prompt')
            examples = [item for item in records if item.get('dataset') == dataset['id']
                        and item['kind'] == 'example']
            if not examples:
                raise ValueError('Add at least one example to the dataset')
            results = []
            for example in reversed(examples):
                try:
                    output, _ = execute(prompt, example['input'])
                    results.append(dict(input=example['input'], expected=example['expected'],
                                        output=output, passed=output == example['expected']))
                except ValueError as error:
                    results.append(dict(input=example['input'], expected=example['expected'],
                                        error=str(error), passed=False))
            return self.save_record('experiment', {'name': required_text('name'), 'dataset': dataset['id'],
                                                   'prompt': prompt['id'], 'results': results})
        if action == 'feedback':
            trace_id = required_text('trace')
            score = data.get('score')
            if type(score) is not int or score not in (0, 1):
                raise ValueError('score must be 0 or 1')
            with database() as connection:
                trace_ids = (json.loads(row[0])['id'] for row in connection.execute('SELECT payload FROM traces'))
                if trace_id not in trace_ids:
                    raise ValueError('Trace was not found')
            return self.save_record('feedback', {'trace': trace_id, 'score': score,
                                                 'comment': required_text('comment')})
        if action == 'playground':
            prompt = record_for('prompt', 'prompt')
            output, tokens = execute(prompt, data.get('input'))
            return {'output': output, 'tokens': tokens}
        if action == 'runs':
            kind = data.get('target_kind')
            if kind not in ('deployment', 'agent'):
                raise ValueError('Invalid run target')
            target = record_for('target', kind)
            if target.get('source') == 'external':
                raise ValueError('External agents run in your application')
            instructions = target.get('instructions')
            provider = next((item for item in records if item['kind'] == 'model'
                             and item['id'] == target.get('provider')), None)
            prompt = next((item for item in records if item['id'] == target.get('prompt')), None)
            start = time.perf_counter()
            step = {'name': 'generate', 'type': 'llm', 'input': data.get('input')} if instructions is not None or os.environ.get('TRACE_STUDIO_MODEL') else {'name': 'render_prompt', 'type': 'template', 'input': data.get('input')}
            tokens = 0
            try:
                step['output'], tokens = execute(prompt, step['input'], instructions, provider)
                status = 'success'
            except ValueError as error:
                step['error'] = str(error)
                status = 'error'
            step['duration'] = (time.perf_counter() - start) * 1000
            trace = dict(step, id=uuid4().hex, name=target['name'], project=kind + ':' + target['name'],
                         status=status, at=datetime.now(timezone.utc).isoformat(), tokens=tokens, cost=0, steps=[step])
            if target.get('identifier'):
                trace.update(agent_id=target['identifier'], environment='local', project='agent:' + target['identifier'])
            with database() as connection:
                connection.execute('INSERT INTO traces VALUES (?)', (json.dumps(trace, allow_nan=False),))
            return trace
        raise ValueError('Unknown action')

    def do_GET(self):
        if self.path == '/api/platform':
            return self.respond(200, [public_record(record) for record in self.records()])

        if self.path != '/api/traces':
            return super().do_GET()
        with database() as connection:
            rows = connection.execute('SELECT payload FROM traces ORDER BY rowid DESC').fetchall()
        self.respond(200, [json.loads(row[0]) for row in rows])

    def do_POST(self):
        if self.path != '/api/traces' and not self.path.startswith('/api/platform/'):
            return self.respond(404, {'error': 'Unknown endpoint'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 1_000_000:
                raise ValueError('Expected a JSON body up to 1 MB')
            def invalid_constant(value):
                raise ValueError('Invalid JSON constant: ' + value)
            trace = json.loads(self.rfile.read(size), parse_constant=invalid_constant)
            if not isinstance(trace, dict):
                raise ValueError('Expected a JSON object')
            if self.path.startswith('/api/platform/'):
                return self.respond(201, self.platform_action(self.path.rsplit('/', 1)[-1], trace))
            if 'agent_id' in trace or 'environment' in trace:
                identifier = trace.get('agent_id')
                environment = trace.get('environment')
                if not isinstance(environment, str) or environment.lower() not in ENVIRONMENTS:
                    raise ValueError('Choose local, development, staging, or production')
                if not isinstance(identifier, str) or not any(
                    item['kind'] == 'agent' and item.get('identifier') == identifier for item in self.records()
                ):
                    raise ValueError('Agent identifier was not found')
                trace['environment'] = environment.lower()
                trace['project'] = 'agent:' + identifier
            trace.setdefault('project', 'default')
            trace.setdefault('status', 'success')
            trace.setdefault('duration', 0)
            trace.setdefault('tokens', 0)
            trace.setdefault('cost', 0)
            trace.setdefault('steps', [])
            if not all(isinstance(trace.get(key), str) and trace[key].strip()
                       for key in ('name', 'project')):
                raise ValueError('name and project must be nonempty strings')
            if trace['status'] not in ('success', 'error'):
                raise ValueError('status must be success or error')
            import math
            for key in ('duration', 'tokens', 'cost'):
                value = trace[key]
                if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
                    raise ValueError(f'{key} must be a finite nonnegative number')
            if not isinstance(trace['steps'], list) or any(
                not isinstance(step, dict) or not isinstance(step.get('name'), str)
                for step in trace['steps']
            ):
                raise ValueError('steps must be a list of objects with a name')
            trace.update(id=uuid4().hex, at=datetime.now(timezone.utc).isoformat())
            payload = json.dumps(trace, allow_nan=False)
        except (ValueError, OverflowError, RecursionError) as error:
            return self.respond(400, {'error': str(error)})
        with database() as connection:
            connection.execute('INSERT INTO traces VALUES (?)', (payload,))
        self.respond(201, trace)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    with database() as connection:
        connection.execute('CREATE TABLE IF NOT EXISTS traces (payload TEXT NOT NULL)')
    print(f'Agent Workshop · http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
