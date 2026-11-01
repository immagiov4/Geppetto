"""Synthetic review sessions; exercises the production coordinator without model calls."""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'skills/code-review/scripts/run_review.py'
spec = importlib.util.spec_from_file_location('review_runner', SOURCE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ReviewStrategyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.case = root / 'case'
        for side in ('before', 'after'):
            (self.case / side).mkdir(parents=True)
            (self.case / side / 'consumer.py').write_text('consume(value)\n', encoding='utf8')
        (self.case / 'before/producer.py').write_text('value = 1\n', encoding='utf8')
        (self.case / 'after/producer.py').write_text('value = 2\n', encoding='utf8')
        (self.case / 'diff.patch').write_text('-value = 1\n+value = 2\n', encoding='utf8')
        (self.case / 'contract.md').write_text('Preserve the consuming behavior.', encoding='utf8')
        runner.save(self.case / 'manifest.json', {'target': 'synthetic', 'changed_files': ['producer.py']})
        self.args = argparse.Namespace(case=self.case, output=root / 'output', codex='synthetic-cli',
                                       strategy='questions', tool_budget=24, model='selected-model',
                                       effort='medium', effort_reason=None, timeout_seconds=480)
        self.question = {'id': 'Q1', 'file': 'producer.py', 'line': 1, 'observation': 'Value changed.',
                         'question': 'Does the consumer accept this value?', 'needed_evidence': 'Read consumer.py.',
                         'relation_type': 'producer-consumer'}
        self.triage = {'id': 'Q1', 'status': 'no_issue', 'checked_sources': ['consumer.py'],
                       'last_consumer': 'consumer.py:1', 'observation': 'The consumer accepts the value.'}
        self.report = {'findings': [], 'coverage': [{'file': 'producer.py', 'aspects': ['consumer behavior'],
                                                   'evidence': 'producer.py:1 → consumer.py:1'}], 'limitations': []}
        self.outputs = {'questions': {'questions': [self.question], 'limitations': []},
                        'investigate': {'report': self.report, 'triage': {'questions': [self.triage], 'limitations': []}},
                        'verify': {'decisions': [], 'accepted_findings': [], 'limitations': []},
                        'search-1': self.report, 'search-2': self.report}
        self.calls = []

    def call(self, args, frozen, label, prompt, schema, metrics):
        runner.unchanged(args.case, frozen)
        self.calls.append((label, prompt))
        metrics['calls'].append({'stage': label, 'status':'returned', 'usage': {'input_tokens': 7}, 'elapsed_seconds': 1})
        response = deepcopy(self.outputs[label])
        runner.save(args.output / f'{label}.json', response)
        return response

    def run_review(self):
        with patch.object(runner, 'run_call', side_effect=self.call):
            runner.main(self.args)
        return json.loads((self.args.output / 'findings.json').read_text(encoding='utf8'))

    def assert_failure(self, message, stages):
        with self.assertRaisesRegex(ValueError, message):
            self.run_review()
        self.assertEqual([label for label, _ in self.calls], stages)
        metrics = json.loads((self.args.output / 'metrics.json').read_text(encoding='utf8'))
        self.assertEqual(metrics['status'], 'failed')
        if metrics['calls']:
            self.assertEqual(metrics['calls'][-1]['status'], 'failed')
        self.assertFalse((self.args.output / 'report.md').exists())

    def test_question_investigation_confirmation_and_retained_triage(self):
        result = self.run_review()
        self.assertEqual([label for label, _ in self.calls], ['questions', 'investigate', 'verify'])
        self.assertIn(self.question['question'], self.calls[1][1])
        self.assertNotIn(self.question['question'], self.calls[2][1])
        self.assertEqual(result['findings'], [])
        self.assertEqual(json.loads((self.args.output / 'triage.json').read_text())['questions'], [self.triage])
        self.assertIn('consumer.py:1', (self.args.output / 'report.md').read_text(encoding='utf8'))

    def test_generic_remains_two_independent_searches(self):
        self.args.strategy = 'generic'
        self.run_review()
        self.assertEqual([label for label, _ in self.calls], ['search-1', 'search-2', 'verify'])

    def test_cli_defaults_to_questions_and_preserves_explicit_generic(self):
        for strategy, first in ((None, 'questions'), ('generic', 'search-1')):
            with self.subTest(strategy=strategy):
                output = self.case.parent / (strategy or 'default-output')
                command = [sys.executable, '-B', str(SOURCE), '--case', str(self.case), '--output', str(output),
                           '--codex', str(self.case.parent / 'missing-codex-executable'), '--timeout-seconds', '1']
                if strategy:
                    command += ['--strategy', strategy]
                result = subprocess.run(command, capture_output=True, text=True,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=30)
                self.assertEqual(result.returncode, 1)
                metrics = json.loads((output / 'metrics.json').read_text(encoding='utf8'))
                self.assertEqual(metrics['strategy'], strategy or 'questions')
                self.assertEqual(metrics['calls'][0]['stage'], first)
                self.assertEqual(metrics['calls'][0]['status'], 'failed')

    def test_no_questions_still_investigates_and_confirms(self):
        self.outputs['questions']['questions'] = []
        self.outputs['investigate']['triage']['questions'] = []
        self.run_review()
        self.assertEqual(len(self.calls), 3)

    def test_duplicate_questions_stop_before_investigation(self):
        self.outputs['questions']['questions'].append(deepcopy(self.question))
        self.assert_failure('Duplicate question', ['questions'])

    def test_question_source_bounds_stop_before_investigation(self):
        self.question['line'] = 2
        self.assert_failure('Question.*source', ['questions'])

    def test_question_may_anchor_unchanged_consumer(self):
        self.question['file'] = 'consumer.py'
        self.run_review()

    def test_question_cap_is_not_silently_truncated(self):
        self.outputs['questions']['questions'] = [{**self.question, 'id': f'Q{i}'} for i in range(21)]
        self.assert_failure('20', ['questions'])

    def test_incomplete_triage_stops_before_confirmation(self):
        self.outputs['investigate']['triage']['questions'] = []
        self.assert_failure('question accounting', ['questions', 'investigate'])

    def test_duplicate_triage_is_not_coverage(self):
        self.outputs['investigate']['triage']['questions'].append(deepcopy(self.triage))
        self.assert_failure('question accounting', ['questions', 'investigate'])

    def test_untraced_no_issue_is_rejected(self):
        self.triage['last_consumer'] = 'none'
        self.assert_failure('consumer', ['questions', 'investigate'])

    def test_unexamined_question_remains_visible(self):
        self.triage.update(status='not_examined', checked_sources=[], last_consumer='none', observation='Budget exhausted.')
        result = self.run_review()
        self.assertTrue(any('Q1' in text and 'not_examined' in text for text in result['limitations']))

    def test_checked_source_must_exist(self):
        self.triage['checked_sources'] = ['missing.py']
        self.assert_failure('source', ['questions', 'investigate'])

    def test_reported_question_requires_a_finding(self):
        self.triage['status'] = 'reported'
        self.assert_failure('reported without a finding', ['questions', 'investigate'])

    def test_confirmed_candidate_keeps_ordinary_report_contract(self):
        finding = {'id':'C-1', 'severity':'P2', 'file':'producer.py', 'line_start':1, 'line_end':1,
                   'title':'Changed value breaks consumer', 'trigger':'Supported input',
                   'consequence':'Wrong output', 'evidence':'producer.py:1 → consumer.py:1',
                   'contract_basis':'Preserve the consuming behavior.'}
        self.report['findings'] = [finding]
        self.triage['status'] = 'reported'
        self.outputs['verify'] = {'accepted_findings':[finding], 'decisions':[
            {'id':'C-1', 'decision':'accept', 'evidence':'Checked producer and consumer.', 'canonical_id':'C-1'}],
            'limitations':[]}
        result = self.run_review()
        self.assertEqual(result['findings'], [finding])
        self.assertEqual(set(result), {'findings','decisions','coverage','limitations'})
        self.assertIn('C-1', self.calls[2][1])

    def test_consumer_finding_reaches_confirmation_and_final_report(self):
        finding = {'id': 'C-1', 'severity': 'P2', 'file': 'consumer.py', 'line_start': 1, 'line_end': 1,
                   'title': 'Changed producer breaks existing consumer', 'trigger': 'Changed value reaches consumer',
                   'consequence': 'Wrong output', 'evidence': 'producer.py:1 → consumer.py:1',
                   'contract_basis': 'Preserve the consuming behavior.'}
        self.report['findings'] = [finding]
        self.triage['status'] = 'reported'
        self.outputs['verify'] = {'accepted_findings': [finding], 'decisions': [
            {'id': 'C-1', 'decision': 'accept', 'evidence': 'Confirmed changed producer breaks consumer.',
             'canonical_id': 'C-1'}], 'limitations': []}
        result = self.run_review()
        self.assertEqual([label for label, _ in self.calls], ['questions', 'investigate', 'verify'])
        self.assertEqual(result['findings'], [finding])
        self.assertIn('consumer.py', (self.args.output / 'report.md').read_text(encoding='utf8'))

    def test_finding_source_cannot_escape_case_or_exceed_real_lines(self):
        for relative, line in (('../contract.md', 1), ('missing.py', 1), ('consumer.py', 2)):
            with self.subTest(relative=relative, line=line):
                with self.assertRaises(ValueError):
                    runner.location(self.case, {'file': relative, 'line_start': line, 'line_end': line})

    def test_question_cannot_escape_case(self):
        self.question['file'] = '../contract.md'
        self.assert_failure('source path', ['questions'])

    def test_missing_schema_field_is_a_failed_stage(self):
        del self.question['observation']
        self.assert_failure('fields', ['questions'])

    def test_no_fallback_after_timeout(self):
        def timeout(*args):
            self.calls.append(('questions', ''))
            raise ValueError('Session time limit reached')
        with patch.object(self, 'call', side_effect=timeout):
            self.assert_failure('time limit', ['questions'])

    def test_changed_source_is_not_a_complete_review(self):
        original = self.call
        def mutate(*args):
            result = original(*args)
            (self.case / 'after/producer.py').write_text('value = 3\n')
            runner.unchanged(args[0].case, args[1])
            return result
        with patch.object(self, 'call', side_effect=mutate):
            self.assert_failure('contents changed', ['questions'])


if __name__ == '__main__':
    unittest.main()
