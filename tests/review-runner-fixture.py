"""Synthetic review sessions; exercises the production coordinator without model calls."""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Barrier, Event
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
        (self.case / 'diff.patch').write_text('diff --git a/producer.py b/producer.py\n--- a/producer.py\n+++ b/producer.py\n'
                                                    '@@ -1 +1 @@\n-value = 1\n+value = 2\n', encoding='utf8')
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

    def test_question_investigation_without_candidates_retains_triage(self):
        result = self.run_review()
        self.assertEqual([label for label, _ in self.calls], ['questions', 'investigate'])
        self.assertIn(self.question['question'], self.calls[1][1])
        self.assertEqual(result['findings'], [])
        self.assertEqual(len(result['coverage']), 1)
        self.assertIn('Confirmed findings: 0. Candidates: 0.', (self.args.output / 'report.md').read_text(encoding='utf8'))
        self.assertEqual(json.loads((self.args.output / 'triage.json').read_text())['questions'], [self.triage])
        self.assertIn('consumer.py:1', (self.args.output / 'report.md').read_text(encoding='utf8'))

    def test_generic_remains_two_independent_searches(self):
        self.args.strategy = 'generic'
        self.report['limitations'] = ['Synthetic coverage limit.']
        result = self.run_review()
        self.assertEqual([label for label, _ in self.calls], ['search-1', 'search-2'])
        self.assertEqual(result['findings'], [])
        self.assertEqual(len(result['coverage']), 2)
        self.assertIn('Synthetic coverage limit.', result['limitations'])
        self.assertIn('Confirmed findings: 0. Candidates: 0.', (self.args.output / 'report.md').read_text(encoding='utf8'))

    def test_cli_defaults_to_lenses_and_preserves_explicit_legacy_strategies(self):
        for strategy, stages in ((None, ['lens-adversarial', 'lens-contracts', 'lens-rules-tests']),
                                 ('questions', ['questions']), ('generic', ['search-1'])):
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
                self.assertEqual(metrics['strategy'], strategy or 'lenses')
                self.assertEqual([call['stage'] for call in metrics['calls']], stages)
                self.assertTrue(all(call['status'] == 'failed' for call in metrics['calls']))
                self.assertEqual(metrics['instructed_tool_budget'], 16 if strategy is None else 24)
                self.assertEqual(metrics['calls'][0]['requested_model'], 'gpt-6.2-sol')

    def test_no_questions_still_investigates(self):
        self.outputs['questions']['questions'] = []
        self.outputs['investigate']['triage']['questions'] = []
        self.run_review()
        self.assertEqual(len(self.calls), 2)

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
        self.assertNotIn(self.question['question'], self.calls[2][1])

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


    lens_stages = ('lens-adversarial', 'lens-contracts', 'lens-rules-tests')
    gap_stages = ('gap-logic', 'gap-contracts-docs')

    def prepare_lenses(self, profile='standard'):
        self.args.strategy = 'lenses'
        self.args.profile = profile
        for stage in self.lens_stages + self.gap_stages:
            self.outputs[stage] = deepcopy(self.report)
        finding = {'id': 'L1-1', 'severity': 'P2', 'file': 'producer.py', 'line_start': 1, 'line_end': 1,
                   'title': 'Producer changes the output', 'trigger': 'Consumer reads value',
                   'consequence': 'Wrong output', 'evidence': 'Value changes on line 1',
                   'contract_basis': 'Preserve the consuming behavior.'}
        self.outputs['lens-adversarial']['findings'] = [finding]
        self.outputs['verify'] = {'accepted_findings': [finding], 'decisions': [
            {'id': 'L1-1', 'decision': 'accept', 'evidence': 'Verified output.', 'canonical_id': 'L1-1'}],
            'limitations': [], 'additional_observations': [
                {'file': 'consumer.py', 'line_start': 1, 'line_end': 1, 'title': 'Other observation',
                 'note': 'Requires separate investigation.'}]}
        return finding

    def read_metrics(self):
        return json.loads((self.args.output / 'metrics.json').read_text(encoding='utf8'))

    def test_lenses_runs_discovery_in_parallel_and_retains_ordered_evidence(self):
        finding = self.prepare_lenses()
        barrier = Barrier(len(self.lens_stages), timeout=5)
        original_call = self.call
        last_lens_returned = Event()

        def call(args, frozen, label, prompt, schema, metrics):
            if label in self.lens_stages:
                self.assertEqual(args.effort, 'medium')
                barrier.wait()
            else:
                self.assertEqual(args.effort, 'high')
            if label == self.lens_stages[0]:
                self.assertTrue(last_lens_returned.wait(5))
            result = original_call(args, frozen, label, prompt, schema, metrics)
            metrics['thread_ids'].append('session-' + label)
            if label == self.lens_stages[-1]:
                last_lens_returned.set()
            return result

        with patch.object(self, 'call', side_effect=call):
            result = self.run_review()
        prompts = dict(self.calls)
        self.assertLess(list(prompts).index(self.lens_stages[-1]), list(prompts).index(self.lens_stages[0]))
        self.assertIn('b1 | -value = 1', prompts['lens-adversarial'])
        self.assertIn('a1 | +value = 2', prompts['lens-rules-tests'])
        self.assertIn('after/producer.py\n1: value = 2', prompts['verify'])
        self.assertIn('before/producer.py\n1: value = 1', prompts['verify'])
        schema = json.loads((self.args.output / 'verification.schema.json').read_text(encoding='utf8'))
        props = schema['properties']
        self.assertEqual(props['decisions']['items']['properties']['id']['enum'], ['L1-1'])
        self.assertEqual(props['decisions']['items']['properties']['canonical_id']['enum'], ['L1-1', '-'])
        self.assertEqual(props['accepted_findings']['items']['properties']['id']['enum'], ['L1-1'])
        self.assertFalse(props['additional_observations']['items']['additionalProperties'])
        self.assertEqual(result['findings'], [finding])
        report = (self.args.output / 'report.md').read_text(encoding='utf8')
        self.assertIn('## Additional observations (unverified)', report)
        self.assertIn('Other observation', report)
        metrics = self.read_metrics()
        stages = [*self.lens_stages, 'verify']
        self.assertEqual([call['stage'] for call in metrics['calls']], stages)
        self.assertEqual(metrics['thread_ids'], ['session-' + stage for stage in stages])
        self.assertEqual(metrics['totals'], {'elapsed_seconds': 4, 'usage': {'input_tokens': 28}})
        self.assertGreater(metrics['wall_seconds'], 0)
        self.assertEqual(metrics['profile'], 'standard')
        self.assertTrue(metrics['parallel_discovery'])
        self.assertGreater(metrics['inline_diff_bytes'], 0)
        self.assertEqual(metrics['inline_diff_omitted_files'], [])
        self.assertEqual(metrics['candidate_count'], 1)

    def test_ultra_sends_first_round_summary_to_two_parallel_gap_lenses(self):
        self.prepare_lenses('ultra')
        self.args.gap_effort = 'low'
        (self.case / 'after/new.py').write_text('result = True\n', encoding='utf8')
        runner.save(self.case / 'manifest.json', {'changed_files': ['new.py', 'producer.py']})
        barrier = Barrier(2, timeout=5)
        original_call = self.call

        def call(args, frozen, label, *rest):
            if label in self.gap_stages:
                self.assertEqual(args.effort, 'low')
                barrier.wait()
            return original_call(args, frozen, label, *rest)

        with patch.object(self, 'call', side_effect=call):
            self.run_review()
        prompts = dict(self.calls)
        for stage in self.gap_stages:
            self.assertIn('"id": "L1-1"', prompts[stage])
            self.assertIn('"changed_files_without_findings": ["new.py"]', prompts[stage])
        self.assertEqual([record['stage'] for record in self.read_metrics()['calls']],
                         [*self.lens_stages, *self.gap_stages, 'verify'])

    def test_packet_budget_prioritizes_source_over_small_fixture_and_excludes_lockfile(self):
        patch_file = self.case / 'diff.patch'
        before = patch_file.read_text(encoding='utf8')
        for name in ('fixtures/a.py', 'uv.lock'):
            source = self.case / 'after' / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text('x\n', encoding='utf8')
            before += f'diff --git a/{name} b/{name}\n--- /dev/null\n+++ b/{name}\n@@ -0,0 +1 @@\n+x\n'
        patch_file.write_text(before, encoding='utf8')
        source_bytes = runner.build_case_packet(self.case, ['producer.py']).inline_diff_bytes
        changed = runner.changed_paths(self.case)
        full = runner.build_case_packet(self.case, changed)
        self.assertEqual(full.omitted_files, ('uv.lock',))
        limited = runner.build_case_packet(self.case, changed, max_diff_bytes=source_bytes)
        self.assertEqual(limited.omitted_files, ('fixtures/a.py', 'uv.lock'))
        self.assertEqual(limited.inline_diff_bytes, source_bytes)
        self.assertIn('a1 | +value = 2', limited.text)

    def test_lenses_reject_invalid_efforts_budgets_and_profiles_before_launch(self):
        cases = [
            ({'strategy': 'generic', 'profile': 'ultra'}, 'ultra.*lenses'),
            ({'strategy': 'questions', 'profile': 'ultra'}, 'ultra.*lenses'),
            ({'verify_effort': 'xhigh'}, 'xhigh'),
            ({'profile': 'ultra', 'gap_effort': 'xhigh'}, 'xhigh'),
            ({'tool_budget': 0}, 'tool budget'),
            ({'max_diff_bytes': -1}, 'diff byte'),
        ]
        for options, error in cases:
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, error):
                args = argparse.Namespace(**(vars(self.args) | {'strategy': 'lenses'} | options))
                runner.main(args)
        self.assertFalse(self.args.output.exists())

    def test_invalid_lens_evidence_prevents_verification_in_serial_mode(self):
        self.args.serial_discovery = True
        for index, (problem, error) in enumerate((
            ('prefix', 'prefixed lens IDs'), ('duplicate', 'prefixed lens IDs'),
            ('coverage', 'unchanged paths'),
        )):
            with self.subTest(problem=problem):
                self.calls.clear()
                finding = self.prepare_lenses()
                self.args.output = self.case.parent / f'invalid-{index}'
                report = self.outputs['lens-adversarial']
                if problem == 'prefix':
                    finding['id'] = 'L2-1'
                elif problem == 'duplicate':
                    report['findings'].append(deepcopy(finding))
                else:
                    report['coverage'][0]['file'] = 'consumer.py'
                with self.assertRaisesRegex(ValueError, error):
                    self.run_review()
                self.assertFalse(self.read_metrics()['parallel_discovery'])
                self.assertNotIn('verify', dict(self.calls))
                self.assertFalse((self.args.output / 'report.md').exists())

    def test_out_of_range_unverified_observation_preserves_confirmed_review(self):
        finding = self.prepare_lenses()
        observation = self.outputs['verify']['additional_observations'][0]
        observation.update(line_start=8, line_end=9)
        result = self.run_review()
        self.assertEqual(result['findings'], [finding])
        self.assertEqual(self.read_metrics()['status'], 'complete')
        report = (self.args.output / 'report.md').read_text(encoding='utf8')
        self.assertIn('## Additional observations (unverified)', report)
        self.assertIn('consumer.py:8-9', report)

    def test_verifier_rejects_out_of_set_id(self):
        self.prepare_lenses()
        self.outputs['verify']['decisions'][0]['id'] = 'L1-99'
        with self.assertRaisesRegex(ValueError, 'outside enumeration'):
            self.run_review()
        self.assertEqual(self.read_metrics()['calls'][-1]['status'], 'failed')
        self.assertFalse((self.args.output / 'report.md').exists())

    def test_parallel_failure_preserves_healthy_stage_and_skips_verification(self):
        self.prepare_lenses()
        original_call = self.call

        def call(args, frozen, label, *rest):
            result = original_call(args, frozen, label, *rest)
            if label == 'lens-contracts':
                raise ValueError('Session time limit reached')
            return result

        with patch.object(self, 'call', side_effect=call), self.assertRaisesRegex(ValueError, 'time limit'):
            self.run_review()
        metrics = self.read_metrics()
        self.assertEqual(metrics['status'], 'failed')
        self.assertEqual([(call['stage'], call['status']) for call in metrics['calls']],
                         list(zip(self.lens_stages, ('completed', 'failed', 'completed'))))
        self.assertFalse((self.args.output / 'report.md').exists())

    def test_case_mutation_in_lens_is_rejected_even_without_candidates(self):
        self.prepare_lenses()
        self.outputs['lens-adversarial']['findings'] = []
        original_call = self.call

        def call(args, frozen, label, *rest):
            result = original_call(args, frozen, label, *rest)
            if label == 'lens-adversarial':
                (self.case / 'after/producer.py').write_text('value = 3\n', encoding='utf8')
            return result

        with patch.object(self, 'call', side_effect=call), self.assertRaisesRegex(ValueError, 'contents changed'):
            self.run_review()
        self.assertFalse((self.args.output / 'report.md').exists())


if __name__ == '__main__':
    unittest.main()
