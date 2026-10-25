---
name: geppetto-behaviour-tests
description: "Test behaviour and invariants. Use to choose meaningful tests, assign checks to measured speed tiers or assess a test that records no design choice."
---

# Behaviour tests

Test product behaviour, product/technical invariants and sensitive paths, including performance where it matters. Call the system as its consumers do and assert the observable result or the design choice being protected. Every added test states that behaviour or choice in one line, usually its name. A test that would pass with the meaningful work removed does not establish the contract.

By default, omit unit tests that document no design choice. Read `unitCoverage` in `.geppetto/config.json`: `"behaviour"` is the default; `"full"` also requests those unit checks. This shared configuration key is the implementation spelling of the proposal's `unit_coverage: full` setting. Test-first product development observes the intended failure before implementation. Exploratory prototypes are exempt; promotion to product requires tests and refactoring.

Measure check duration before choosing its frequency. Useful tiers include lint, static gates, behaviours, system checks and real use. They are not a rigid hierarchy: actual cost determines placement. A fast integration check can run more often than a slow unit suite. Report measured durations with their revision and workload, separating overlapping time. Evolve minimal test infrastructure as demonstrated needs grow.

Document significant fuzzing, generative checks or other powerful verification beside the test, or in the feature's `## Verification` when adopt configured that preference. Keep the feature's verification declaration tied to the real test and its limits. Complete when the check protects an identified behaviour, fails on its regression and runs at a frequency justified by measured cost. This principle works on its own even alongside an equivalent personal test principle.
